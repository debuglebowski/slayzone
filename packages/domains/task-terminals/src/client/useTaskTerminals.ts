import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useSubscription } from '@slayzone/transport/client'
import { useTRPC, useTRPCClient } from './trpc'
import type { TerminalTab, TerminalGroup } from '../shared/types'
import type { TerminalMode } from '@slayzone/terminal-contracts'
import { usePty } from '@slayzone/terminal'

interface UseTaskTerminalsResult {
  tabs: TerminalTab[]
  groups: TerminalGroup[]
  activeGroupId: string
  setActiveGroupId: (id: string) => void
  createTab: (mode?: TerminalMode) => Promise<TerminalTab>
  splitTab: (tabId: string) => Promise<TerminalTab | null>
  closeTab: (tabId: string) => Promise<boolean>
  movePane: (tabId: string, targetGroupId: string | null) => Promise<void>
  renameTab: (tabId: string, label: string | null) => Promise<void>
  getSessionId: (tabId: string) => string
}

function computeGroups(tabs: TerminalTab[]): TerminalGroup[] {
  const map = new Map<string, TerminalTab[]>()
  for (const tab of tabs) {
    const existing = map.get(tab.groupId)
    if (existing) {
      existing.push(tab)
    } else {
      map.set(tab.groupId, [tab])
    }
  }

  const groups: TerminalGroup[] = []
  for (const [id, groupTabs] of map) {
    groupTabs.sort((a, b) => a.position - b.position)
    groups.push({
      id,
      tabs: groupTabs,
      isMain: groupTabs.some((t) => t.isMain)
    })
  }

  // Sort groups: main first, then by first tab's position
  groups.sort((a, b) => {
    if (a.isMain && !b.isMain) return -1
    if (!a.isMain && b.isMain) return 1
    return (a.tabs[0]?.position ?? 0) - (b.tabs[0]?.position ?? 0)
  })

  return groups
}

export function useTaskTerminals(
  taskId: string,
  defaultMode: TerminalMode
): UseTaskTerminalsResult {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const [tabs, setTabs] = useState<TerminalTab[]>([])
  const [activeGroupId, setActiveGroupId] = useState<string>(taskId) // Main group id = taskId
  const closingTabIdsRef = useRef<Set<string>>(new Set())
  const { subscribeExit } = usePty()

  // Tab CRUD mutations. The hook keeps its own optimistic `tabs` state (created
  // tab pushed, deleted tab filtered) so these are imperative `mutateAsync`
  // calls — list refetch is driven by the server `onChanged` broadcast below.
  const { mutateAsync: createTerminal } = useMutation(trpc.taskTerminals.create.mutationOptions())
  const { mutateAsync: splitTerminal } = useMutation(trpc.taskTerminals.split.mutationOptions())
  const { mutateAsync: deleteTerminal } = useMutation(trpc.taskTerminals.delete.mutationOptions())
  const { mutateAsync: moveTerminalToGroup } = useMutation(
    trpc.taskTerminals.moveToGroup.mutationOptions()
  )
  const { mutateAsync: updateTerminal } = useMutation(trpc.taskTerminals.update.mutationOptions())
  const { mutateAsync: ptyKill } = useMutation(trpc.pty.kill.mutationOptions())
  const { mutateAsync: chatRemove } = useMutation(trpc.chat.remove.mutationOptions())

  const groups = useMemo(() => computeGroups(tabs), [tabs])

  // Load tabs on mount
  useEffect(() => {
    const loadTabs = async () => {
      try {
        await trpcClient.taskTerminals.ensureMain.mutate({ taskId, mode: defaultMode })
        const loadedTabs = await trpcClient.taskTerminals.list.query({ taskId })
        setTabs(loadedTabs)
        // Set active to main group if the current active one doesn't exist
        const loadedGroups = computeGroups(loadedTabs)
        const mainGroup = loadedGroups.find((g) => g.isMain)
        if (mainGroup) {
          setActiveGroupId((current) =>
            loadedGroups.some((g) => g.id === current) ? current : mainGroup.id
          )
        }
      } catch (err) {
        console.error('[useTaskTerminals] Failed to load tabs:', err)
      }
    }
    loadTabs()
  }, [taskId, defaultMode, trpcClient])

  // Re-fetch when an external actor (CLI via REST, other window) mutates tabs.
  // Optionally focus the new tab's group if `focusTabId` is provided. Server
  // fan-out is global; filter by taskId in onData.
  useSubscription(
    trpc.taskTerminals.onChanged.subscriptionOptions(undefined, {
      onData: async ({ taskId: changedTaskId, focusTabId }) => {
        if (changedTaskId !== taskId) return
        try {
          const loadedTabs = await trpcClient.taskTerminals.list.query({ taskId })
          setTabs(loadedTabs)
          if (focusTabId) {
            const target = loadedTabs.find((t) => t.id === focusTabId)
            if (target) setActiveGroupId(target.groupId)
          }
        } catch (err) {
          console.error('[useTaskTerminals] Failed to refresh tabs:', err)
        }
      }
    })
  )

  // Create a new group with one terminal
  const createTab = useCallback(
    async (mode?: TerminalMode): Promise<TerminalTab> => {
      const newTab = await createTerminal({ taskId, mode: mode || 'terminal' })
      setTabs((prev) => [...prev, newTab])
      setActiveGroupId(newTab.groupId)
      return newTab
    },
    [createTerminal, taskId]
  )

  // Split: add a new pane to the same group as the target tab
  const splitTab = useCallback(
    async (tabId: string): Promise<TerminalTab | null> => {
      const newTab = await splitTerminal({ tabId })
      if (newTab) {
        setTabs((prev) => [...prev, newTab])
      }
      return newTab
    },
    [splitTerminal]
  )

  const closeTabInternal = useCallback(
    (tabId: string, skipKill: boolean): Promise<boolean> => {
      if (closingTabIdsRef.current.has(tabId)) return Promise.resolve(false)
      closingTabIdsRef.current.add(tabId)
      const close = async (): Promise<boolean> => {
        const success = await deleteTerminal({ tabId })
        if (success) {
          const sessionId = `${taskId}:${tabId}`
          if (!skipKill) {
            await ptyKill({ sessionId })
          }
          // Reap chat session for this tab regardless of mode — chat.remove is
          // a no-op when no session exists. Without this, a chat-mode tab's claude
          // subprocess + in-memory session map entry leak until app shutdown.
          try {
            await chatRemove({ tabId })
          } catch {
            /* ignore — chat session may not exist */
          }

          setTabs((prev) => {
            const remaining = prev.filter((t) => t.id !== tabId)
            // If the closed tab's group is now empty, we'll handle group switching below
            return remaining
          })

          // Check if we need to switch active group
          setActiveGroupId((prev) => {
            // Recompute from the updated tabs to see if the group still exists
            // We use functional updater on tabs to peek at current state
            return prev // Corrected during render below if the group is gone
          })
        }
        return success
      }
      return close().finally(() => {
        closingTabIdsRef.current.delete(tabId)
      })
    },
    [deleteTerminal, ptyKill, chatRemove, taskId]
  )

  const closeTab = useCallback(
    async (tabId: string): Promise<boolean> => {
      return closeTabInternal(tabId, false)
    },
    [closeTabInternal]
  )

  // Auto-close secondary terminal tabs when their PTY exits.
  useEffect(() => {
    const unsubs: Array<() => void> = []

    for (const tab of tabs) {
      if (tab.isMain) continue
      const sessionId = `${taskId}:${tab.id}`
      const unsub = subscribeExit(sessionId, () => {
        void closeTabInternal(tab.id, true)
      })
      unsubs.push(unsub)
    }

    return () => {
      unsubs.forEach((unsub) => unsub())
    }
  }, [tabs, taskId, subscribeExit, closeTabInternal])

  // Correct activeGroupId if the active group no longer exists. Adjusted during
  // render (converges in one pass) so no frame renders a missing active group.
  if (groups.length > 0 && !groups.some((g) => g.id === activeGroupId)) {
    const mainGroup = groups.find((g) => g.isMain)
    setActiveGroupId(mainGroup?.id ?? groups[0].id)
  }

  // Move a pane to a different group (null = new standalone group)
  const movePane = useCallback(
    async (tabId: string, targetGroupId: string | null): Promise<void> => {
      const updated = await moveTerminalToGroup({ tabId, targetGroupId })
      if (updated) {
        setTabs((prev) => prev.map((t) => (t.id === tabId ? updated : t)))
      }
    },
    [moveTerminalToGroup]
  )

  const renameTab = useCallback(
    async (tabId: string, label: string | null): Promise<void> => {
      const updated = await updateTerminal({ id: tabId, label })
      if (updated) {
        setTabs((prev) => prev.map((t) => (t.id === tabId ? updated : t)))
      }
    },
    [updateTerminal]
  )

  const getSessionId = useCallback(
    (tabId: string): string => {
      return `${taskId}:${tabId}`
    },
    [taskId]
  )

  return {
    tabs,
    groups,
    activeGroupId,
    setActiveGroupId,
    createTab,
    splitTab,
    closeTab,
    movePane,
    renameTab,
    getSessionId
  }
}
