// @vitest-environment jsdom
// Pins useBrowserLock's writes to the panel's LATEST tabs. BrowserPanel's webview
// syncs (url / title / favicon) write the tabs they read from its ref, updated on
// every write; the auto-lock wrote the render's snapshot through the parent instead,
// so a title landing in the same commit wrote the pre-lock tabs back: the lock was
// gone from the screen and the DB (e2e browser/87 under load).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { BrowserTab, BrowserTabsState } from '../shared'

vi.mock('@slayzone/transport/client', () => ({
  useTRPC: () => ({
    menu: { onBrowserAgentTouched: { subscriptionOptions: (_i: unknown, o: unknown) => o } }
  }),
  useSubscription: () => undefined
}))
vi.mock('./trpc', async () => await import('@slayzone/transport/client'))
const persisted: Array<{ tabId: string; locked: boolean }> = []
vi.mock('./BrowserTaskSource', () => ({
  useSetBrowserTabLocked: () => (input: { tabId: string; locked: boolean }) =>
    persisted.push({ tabId: input.tabId, locked: input.locked })
}))

const { useBrowserLock } = await import('./useBrowserLock')

afterEach(() => {
  cleanup()
  persisted.length = 0
})

const tab = (over: Partial<BrowserTab> = {}): BrowserTab => ({
  id: 't1',
  url: 'about:blank',
  title: 'blank',
  ...over
})

/** BrowserPanel's tabs: the parent's state plus the ref every webview sync writes through. */
function panel(initial: BrowserTabsState) {
  const latest = { current: initial }
  const parentWrites: BrowserTabsState[] = []
  const commitTabs = (next: BrowserTabsState) => {
    latest.current = next
    parentWrites.push(next)
  }
  /** A webview sync as BrowserPanel's patchActiveTab does it. */
  const syncTitle = (title: string) => {
    const t = latest.current
    commitTabs({ ...t, tabs: t.tabs.map((x) => (x.id === t.activeTabId ? { ...x, title } : x)) })
  }
  return { latest, parentWrites, commitTabs, syncTitle }
}

describe('useBrowserLock', () => {
  it('the auto-lock survives a webview sync landing right after it', () => {
    const p = panel({ tabs: [tab({ agentTouched: false })], activeTabId: 't1' })
    const props = (tabs: BrowserTabsState) => ({
      taskId: 'task-1',
      tabs,
      activeTab: tabs.tabs[0] ?? null,
      latestTabs: () => p.latest.current,
      commitTabs: p.commitTabs,
      // The pre-fix signature: the parent's setter, which no ref sees until a re-render.
      onTabsChange: (next: BrowserTabsState) => p.parentWrites.push(next)
    })
    const h = renderHook((tabs: BrowserTabsState) => useBrowserLock(props(tabs)), {
      initialProps: p.latest.current
    })
    // The agent touched the tab (tasks:changed); the render the effect runs in.
    const touched = { tabs: [tab({ agentTouched: true })], activeTabId: 't1' }
    p.latest.current = touched
    act(() => h.rerender(touched))
    // Same commit: the navigated page's title arrives.
    act(() => p.syncTitle('page-a'))

    expect(persisted).toEqual([{ tabId: 't1', locked: true }])
    expect(p.latest.current.tabs[0]).toMatchObject({ locked: true, title: 'page-a' })
    expect(p.parentWrites.at(-1)?.tabs[0]).toMatchObject({ locked: true, title: 'page-a' })
  })

  it('the toggle flips the latest tabs, keeping a sync that landed since the render', () => {
    const p = panel({ tabs: [tab({ agentTouched: true, locked: true })], activeTabId: 't1' })
    const h = renderHook(() =>
      useBrowserLock({
        taskId: 'task-1',
        tabs: p.latest.current,
        activeTab: p.latest.current.tabs[0] ?? null,
        latestTabs: () => p.latest.current,
        commitTabs: p.commitTabs
      })
    )
    act(() => p.syncTitle('since the render'))
    act(() => h.result.current.toggleActiveLock())
    expect(persisted).toEqual([{ tabId: 't1', locked: false }])
    expect(p.latest.current.tabs[0]).toMatchObject({ locked: false, title: 'since the render' })
  })
})
