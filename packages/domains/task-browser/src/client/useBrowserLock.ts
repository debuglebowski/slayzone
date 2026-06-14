import { useEffect, useRef } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useSubscription, useTRPC } from '@slayzone/transport/client'
import type { BrowserTab, BrowserTabsState } from '../shared'

interface UseBrowserLockParams {
  taskId?: string
  tabs: BrowserTabsState
  onTabsChange: (tabs: BrowserTabsState) => void
  activeTab: BrowserTab | null
}

export function useBrowserLock({ taskId, tabs, onTabsChange, activeTab }: UseBrowserLockParams) {
  const trpc = useTRPC()
  const setLockedMutation = useMutation(trpc.task.setBrowserTabLocked.mutationOptions())
  const setLocked = setLockedMutation.mutate

  // Previous agentTouched value per tab id. We auto-lock only on a live
  // `false → true` transition (i.e. observed during this session). First-time
  // observation of an already-touched tab (e.g. after app restart) records the
  // value silently so the user's previous unlock survives.
  const prevTouchedRef = useRef<Map<string, boolean>>(new Map())

  // Auto-lock on observed `agentTouched: false → true` transition per tab.
  // The flag is sticky in the DB, but auto-lock fires only on live transitions
  // during this renderer session — app restarts that re-open already-touched
  // tabs record the value silently so the user's previous unlock survives.
  // BrowserTabPlaceholder owns the IPC sync to main, so backgrounded tabs
  // whose viewId isn't registered yet still lock once their placeholder mounts.
  useEffect(() => {
    if (!taskId) return
    let toLock: string | null = null
    for (const tab of tabs.tabs) {
      const curr = !!tab.agentTouched
      const prev = prevTouchedRef.current.get(tab.id)
      prevTouchedRef.current.set(tab.id, curr)
      if (prev === false && curr && !tab.locked) {
        toLock = tab.id
        setLocked({ taskId, tabId: tab.id, locked: true })
      }
    }
    if (toLock) {
      // Stamp locked locally too — the DB write goes through tasks:changed,
      // but local tabs state can lag behind for a tick, leaving the lock
      // banner stale. Pre-applying here keeps the UI in sync immediately.
      onTabsChange({
        ...tabs,
        tabs: tabs.tabs.map((t) => (t.id === toLock ? { ...t, locked: true } : t))
      })
    }
  }, [taskId, tabs, onTabsChange, setLocked])

  // Latest tabs / onTabsChange kept in refs so the subscription handler reads
  // fresh values without re-subscribing (tearing down the WS sub) on every tab
  // update.
  const tabsRef = useRef(tabs)
  const onTabsChangeRef = useRef(onTabsChange)
  useEffect(() => {
    tabsRef.current = tabs
    onTabsChangeRef.current = onTabsChange
  }, [tabs, onTabsChange])

  // Listen for server-side trip events. The server also persists to DB and
  // notifies via tasks:changed, but renderer-local tabs state may have stale
  // values in flight that would clobber the flag on next writeback — stamp it
  // locally now so any pending update preserves it.
  //
  // Rides `menu.onBrowserAgentTouched` (tRPC over WS) — was the electron-native
  // The old preload browser-agent listener before preload became
  // bootstrap-only.
  useSubscription(
    trpc.menu.onBrowserAgentTouched.subscriptionOptions(undefined, {
      enabled: !!taskId,
      onData: ({ taskId: evtTaskId, tabId }) => {
        if (evtTaskId !== taskId) return
        const tabsState = tabsRef.current
        const target = tabsState.tabs.find((t) => t.id === tabId)
        if (!target || target.agentTouched === true) return
        onTabsChangeRef.current({
          ...tabsState,
          tabs: tabsState.tabs.map((t) => (t.id === tabId ? { ...t, agentTouched: true } : t))
        })
      }
    })
  )

  const activeLocked = !!activeTab?.locked

  const toggleActiveLock = () => {
    if (!activeTab || !taskId) return
    const next = !activeTab.locked
    setLocked({ taskId, tabId: activeTab.id, locked: next })
    // Stamp locked locally (same reason as the auto-lock effect above) so
    // the banner shows/hides immediately rather than waiting for tasks:changed.
    onTabsChange({
      ...tabs,
      tabs: tabs.tabs.map((t) => (t.id === activeTab.id ? { ...t, locked: next } : t))
    })
  }

  return { activeLocked, toggleActiveLock }
}
