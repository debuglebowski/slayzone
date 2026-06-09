import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useSubscription, useTRPC, useTRPCClient } from '@slayzone/transport/client'
import type { TerminalTab, TerminalGroup } from '../shared/types'
import type { TerminalMode } from '@slayzone/terminal/shared'
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
  const createMutation = useMutation(trpc.taskTerminals.create.mutationOptions())
  const splitMutation = useMutation(trpc.taskTerminals.split.mutationOptions())
  const deleteMutation = useMutation(trpc.taskTerminals.delete.mutationOptions())
  const moveToGroupMutation = useMutation(trpc.taskTerminals.moveToGroup.mutationOptions())
  const updateMutation = useMutation(trpc.taskTerminals.update.mutationOptions())
  const ptyKillMutation = useMutation(trpc.pty.kill.mutationOptions())
  const chatRemoveMutation = useMutation(trpc.chat.remove.mutationOptions())

  const groups = useMemo(() => computeGroups(tabs), [tabs])

  // Load tabs on mount
  useEffect(() => {
    const loadTabs = async () => {
      try {
        await trpcClient.taskTerminals.ensureMain.mutate({ taskId, mode: defaultMode })
        const loadedTabs = await trpcClient.taskTerminals.list.query({ taskId })
        setTabs(loadedTabs)
        // Set active to main group if current active doesn't exist
        const loadedGroups = computeGroups(loadedTabs)
        if (!loadedGroups.find((g) => g.id === activeGroupId)) {
          const mainGroup = loadedGroups.find((g) => g.isMain)
          if (mainGroup) setActiveGroupId(mainGroup.id)
        }
      } catch (err) {
        console.error('[useTaskTerminals] Failed to load tabs:', err)
      }
    }
    loadTabs()
  }, [taskId, defaultMode])

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
      const newTab = await createMutation.mutateAsync({ taskId, mode: mode || 'terminal' })
      setTabs((prev) => [...prev, newTab])
      setActiveGroupId(newTab.groupId)
      return newTab
    },
    [createMutation, taskId]
  )

  // Split: add a new pane to the same group as the target tab
  const splitTab = useCallback(
    async (tabId: string): Promise<TerminalTab | null> => {
      const newTab = await splitMutation.mutateAsync({ tabId })
      if (newTab) {
        setTabs((prev) => [...prev, newTab])
      }
      return newTab
    },
    [splitMutation]
  )

  const closeTabInternal = useCallback(
    async (tabId: string, skipKill: boolean): Promise<boolean> => {
      if (closingTabIdsRef.current.has(tabId)) return false
      closingTabIdsRef.current.add(tabId)
      try {
        const success = await deleteMutation.mutateAsync({ tabId })
        if (success) {
          const sessionId = `${taskId}:${tabId}`
          if (!skipKill) {
            await ptyKillMutation.mutateAsync({ sessionId })
          }
          // Reap chat session for this tab regardless of mode — chat.remove is
          // a no-op when no session exists. Without this, a chat-mode tab's claude
          // subprocess + in-memory session map entry leak until app shutdown.
          try {
            await chatRemoveMutation.mutateAsync({ tabId })
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
            return prev // Will be corrected in the effect below if needed
          })
        }
        return success
      } finally {
        closingTabIdsRef.current.delete(tabId)
      }
    },
    [chatRemoveMutation, deleteMutation, ptyKillMutation, taskId]
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

  // Correct activeGroupId if the active group no longer exists
  useEffect(() => {
    const activeGroup = groups.find((g) => g.id === activeGroupId)
    if (!activeGroup && groups.length > 0) {
      const mainGroup = groups.find((g) => g.isMain)
      setActiveGroupId(mainGroup?.id ?? groups[0].id)
    }
  }, [groups, activeGroupId])

  // Move a pane to a different group (null = new standalone group)
  const movePane = useCallback(
    async (tabId: string, targetGroupId: string | null): Promise<void> => {
      const updated = await moveToGroupMutation.mutateAsync({ tabId, targetGroupId })
      if (updated) {
        setTabs((prev) => prev.map((t) => (t.id === tabId ? updated : t)))
      }
    },
    [moveToGroupMutation]
  )

  const renameTab = useCallback(
    async (tabId: string, label: string | null): Promise<void> => {
      const updated = await updateMutation.mutateAsync({ id: tabId, label })
      if (updated) {
        setTabs((prev) => prev.map((t) => (t.id === tabId ? updated : t)))
      }
    },
    [updateMutation]
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
