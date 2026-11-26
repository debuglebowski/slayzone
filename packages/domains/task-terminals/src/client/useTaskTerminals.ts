import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useHubReopen, useSubscription } from '@slayzone/transport/client'
import { useTRPC, useTRPCClient } from './trpc'
import type { TerminalTab, TerminalGroup } from '../shared/types'
import type { AgentId } from '@slayzone/terminal-contracts'
import { usePty } from '@slayzone/terminal'
import { isModeSwitchExit } from './mode-switch'

/**
 * A task's tabs, opened read-only — including while the task is migrating: the main
 * tab is provisioned or synchronized only when it is missing or in another mode. The
 * main tab is the task creator's (T-100): someone else working on a shared task has
 * only the tabs they open themselves, so a NOT_FOUND refusal here is not an error.
 */
async function loadTaskTabs(
  client: ReturnType<typeof useTRPCClient>,
  taskId: string,
  defaultMode: AgentId
): Promise<TerminalTab[]> {
  const tabs = await client.taskTerminals.list.query({ taskId })
  const main = tabs.find((tab) => tab.isMain)
  if (main && main.mode === defaultMode) return tabs
  const ensured = await client.taskTerminals.ensureMain.mutate({ taskId, mode: defaultMode }).then(
    () => true,
    (err: unknown) => {
      if ((err as { data?: { code?: string } })?.data?.code !== 'NOT_FOUND') throw err
      return false
    }
  )
  return ensured ? client.taskTerminals.list.query({ taskId }) : tabs
}

/**
 * Where the first read of a task's tabs stands. `failed` is not "no tabs": the hub
 * could not answer (e.g. its socket dropped mid-read), so the pane must not offer
 * to start an agent as if the task had none of the user's.
 */
export type TabsLoadState = 'loading' | 'loaded' | 'failed'

interface UseTaskTerminalsResult {
  tabs: TerminalTab[]
  loadState: TabsLoadState
  /** Read the task's tabs again (a failed load's retry). */
  reload: () => void
  groups: TerminalGroup[]
  activeGroupId: string
  setActiveGroupId: (id: string) => void
  createTab: (mode?: AgentId) => Promise<TerminalTab>
  splitTab: (tabId: string) => Promise<TerminalTab | null>
  closeTab: (tabId: string) => Promise<boolean>
  movePane: (tabId: string, targetGroupId: string | null) => Promise<void>
  renameTab: (tabId: string, label: string | null) => Promise<void>
  /** A chat tab's own font size, px; null follows the `chat_font_size` setting. */
  setChatFontSize: (tabId: string, size: number | null) => Promise<void>
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

export function useTaskTerminals(taskId: string, defaultMode: AgentId): UseTaskTerminalsResult {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const [tabs, setTabs] = useState<TerminalTab[]>([])
  const [loadState, setLoadState] = useState<TabsLoadState>('loading')
  const [loadGeneration, setLoadGeneration] = useState(0)
  const reload = useCallback(() => setLoadGeneration((g) => g + 1), [])
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

  // Load tabs on mount, and again on `reload`. A load for a previous task, mode or
  // client never lands.
  useEffect(() => {
    let current = true
    loadTaskTabs(trpcClient, taskId, defaultMode)
      .then((loadedTabs) => {
        if (!current) return
        setTabs(loadedTabs)
        setLoadState('loaded')
        // Set active to main group if the current active one doesn't exist
        const loadedGroups = computeGroups(loadedTabs)
        const mainGroup = loadedGroups.find((g) => g.isMain)
        if (mainGroup) {
          setActiveGroupId((current) =>
            loadedGroups.some((g) => g.id === current) ? current : mainGroup.id
          )
        }
      })
      .catch((err: unknown) => {
        if (!current) return
        console.error('[useTaskTerminals] Failed to load tabs:', err)
        setLoadState('failed')
      })
    return () => {
      current = false
    }
  }, [taskId, defaultMode, trpcClient, loadGeneration])

  // The hub's socket reopened: a failed load can succeed now, and after a drop the
  // `onChanged` pushes sent while it was down never arrived.
  useHubReopen((dropped) => {
    if (dropped || loadState === 'failed') reload()
  })

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
    async (mode?: AgentId): Promise<TerminalTab> => {
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
        // Killed to restart in another mode (an agent panel's provider): keep the tab.
        if (isModeSwitchExit(sessionId)) return
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

  const setChatFontSize = useCallback(
    async (tabId: string, size: number | null): Promise<void> => {
      // Optimistic: the size applies at once; the server's row confirms it, and a
      // failed save puts the previous size back.
      const previous = tabs.find((t) => t.id === tabId)?.chatFontSize ?? null
      const apply = (value: number | null) =>
        setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, chatFontSize: value } : t)))
      apply(size)
      const updated = await updateTerminal({ id: tabId, chatFontSize: size }).catch(
        (err: unknown) => {
          console.error('[useTaskTerminals] Failed to save chat font size:', err)
          apply(previous)
          return null
        }
      )
      if (updated) apply(updated.chatFontSize)
    },
    [tabs, updateTerminal]
  )

  const getSessionId = useCallback(
    (tabId: string): string => {
      return `${taskId}:${tabId}`
    },
    [taskId]
  )

  return {
    tabs,
    loadState,
    reload,
    groups,
    activeGroupId,
    setActiveGroupId,
    createTab,
    splitTab,
    closeTab,
    movePane,
    renameTab,
    setChatFontSize,
    getSessionId
  }
}
