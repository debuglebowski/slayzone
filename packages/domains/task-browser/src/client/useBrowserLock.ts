import { useEffect, useRef } from 'react'
import { useSubscription } from '@slayzone/transport/client'
import { useTRPC } from './trpc'
import { useStableCallback } from '@slayzone/ui'
import type { BrowserTab, BrowserTabsState } from '../shared'
import { useSetBrowserTabLocked } from './BrowserTaskSource'

interface UseBrowserLockParams {
  taskId?: string
  /** The rendered tabs: what auto-lock watches for an agent's first touch. */
  tabs: BrowserTabsState
  /**
   * The panel's latest tabs and its one write path (BrowserPanel `tabsRef` /
   * `commitTabsUpdate`), shared with the webview syncs. Every write here starts
   * from `latestTabs()`: written from the render's snapshot through the parent, a
   * lock was undone by a title sync in the same commit, which read the ref.
   */
  latestTabs: () => BrowserTabsState
  commitTabs: (tabs: BrowserTabsState) => void
  activeTab: BrowserTab | null
}

/** `tabs` with tab `tabId` patched. */
function patchTab(
  tabs: BrowserTabsState,
  tabId: string,
  patch: Partial<BrowserTab>
): BrowserTabsState {
  return { ...tabs, tabs: tabs.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)) }
}

export function useBrowserLock({
  taskId,
  tabs,
  latestTabs,
  commitTabs,
  activeTab
}: UseBrowserLockParams) {
  const trpc = useTRPC()
  const setLocked = useSetBrowserTabLocked()

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
      commitTabs(patchTab(latestTabs(), toLock, { locked: true }))
    }
  }, [taskId, tabs, latestTabs, commitTabs, setLocked])

  // Listen for server-side trip events. The server also persists to DB and
  // notifies via tasks:changed, but renderer-local tabs state may have stale
  // values in flight that would clobber the flag on next writeback — stamp it
  // locally now so any pending update preserves it.
  //
  // Rides `menu.onBrowserAgentTouched` (tRPC over WS) — was the electron-native
  // The old preload browser-agent listener before preload became
  // bootstrap-only.
  //
  // Stable handler reads the latest tabs / commitTabs without
  // re-subscribing (tearing down the WS sub) on every tab update.
  const handleAgentTouched = useStableCallback(
    ({ taskId: evtTaskId, tabId }: { taskId: string; tabId: string }) => {
      if (evtTaskId !== taskId) return
      const latest = latestTabs()
      const target = latest.tabs.find((t) => t.id === tabId)
      if (!target || target.agentTouched === true) return
      commitTabs(patchTab(latest, tabId, { agentTouched: true }))
    }
  )
  useSubscription(
    trpc.menu.onBrowserAgentTouched.subscriptionOptions(undefined, {
      enabled: !!taskId,
      onData: handleAgentTouched
    })
  )

  const activeLocked = !!activeTab?.locked

  const toggleActiveLock = () => {
    if (!activeTab || !taskId) return
    const next = !activeTab.locked
    setLocked({ taskId, tabId: activeTab.id, locked: next })
    // Stamp locked locally (same reason as the auto-lock effect above) so
    // the banner shows/hides immediately rather than waiting for tasks:changed.
    commitTabs(patchTab(latestTabs(), activeTab.id, { locked: next }))
  }

  return { activeLocked, toggleActiveLock }
}
