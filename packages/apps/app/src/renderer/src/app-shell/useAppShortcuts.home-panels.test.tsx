// @vitest-environment jsdom
// Home-tab panel shortcuts read the CURRENT panel settings when a key fires. A
// settings change alone (Tests panel enabled, a panel turned on) must reach the
// listener — no project switch or panel toggle needed first.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'

vi.mock('@slayzone/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@slayzone/ui')>()),
  useGuardedHotkeys: () => undefined,
  // Key strings stand in for chords: an event "matches" when its key IS the chord.
  matchesShortcut: (e: KeyboardEvent, keys: string | null) => keys !== null && e.key === keys
}))
vi.mock('@slayzone/telemetry/client', () => {
  const tracker = {
    track: vi.fn(),
    trackTask: vi.fn(),
    trackProject: vi.fn(),
    trackShortcut: vi.fn()
  }
  return { useTrack: () => tracker }
})

const { useTabStore } = await import('@slayzone/tabs-state')
const { resolveShortcutKeys } = await import('@slayzone/ui')
const { useAppShortcuts } = await import('./useAppShortcuts')

type Deps = Parameters<typeof useAppShortcuts>[0]

const setHomePanelVisibility = vi.fn()
const homePanel = {
  homePanelVisibility: {},
  setHomePanelVisibility,
  setHomeGitDefaultTab: vi.fn(),
  homeEditorRef: { current: null },
  homeGitPanelRef: { current: null },
  pendingHomeSearchToggleRef: { current: false }
} as unknown as Deps['homePanel']
const noop = (): void => {}
const stable = {
  projects: [],
  homePanel,
  selectedProjectId: 'p1',
  visibleTabs: [],
  toFullIndex: (i: number) => i,
  toVisibleIndex: (i: number) => i,
  tabCycleOrder: [],
  setActiveTabIndex: noop,
  setSelectedProjectId: noop,
  reopenClosedTab: async () => {},
  openTask: noop,
  undo: noop,
  redo: noop,
  zenMode: false,
  setZenMode: noop,
  explodeMode: false,
  setExplodeMode: noop,
  openTaskIds: [],
  globalAgentPanelState: {},
  setGlobalAgentPanelState: noop,
  agentStatusState: {},
  setAgentStatusState: noop
} as unknown as Omit<Deps, 'isHomePanelEnabled' | 'testsPanelEnabled'>

const press = (id: string): void => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: resolveShortcutKeys({}, id) ?? '' }))
}
const allEnabled = (): boolean => true
const noneEnabled = (): boolean => false

beforeEach(() => {
  setHomePanelVisibility.mockClear()
  useTabStore.setState({ tabs: [{ type: 'home' }], activeTabIndex: 0 } as never)
})
afterEach(cleanup)

describe('home panel shortcuts', () => {
  it('see the Tests panel once it is enabled', () => {
    const { rerender } = renderHook((d: Deps) => useAppShortcuts(d), {
      initialProps: { ...stable, isHomePanelEnabled: allEnabled, testsPanelEnabled: false }
    })
    press('panel-tests')
    expect(setHomePanelVisibility).not.toHaveBeenCalled()

    rerender({ ...stable, isHomePanelEnabled: allEnabled, testsPanelEnabled: true })
    press('panel-tests')
    expect(setHomePanelVisibility).toHaveBeenCalledTimes(1)
  })

  it('see a panel once it is enabled in the panel config', () => {
    const { rerender } = renderHook((d: Deps) => useAppShortcuts(d), {
      initialProps: { ...stable, isHomePanelEnabled: noneEnabled, testsPanelEnabled: true }
    })
    press('panel-processes')
    expect(setHomePanelVisibility).not.toHaveBeenCalled()

    rerender({ ...stable, isHomePanelEnabled: allEnabled, testsPanelEnabled: true })
    press('panel-processes')
    expect(setHomePanelVisibility).toHaveBeenCalledTimes(1)
  })
})
