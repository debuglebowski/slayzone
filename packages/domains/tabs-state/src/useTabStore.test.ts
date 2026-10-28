/**
 * Tab store unit tests
 */
import { beforeEach, describe, expect, test } from 'vitest'

import {
  useTabStore,
  parseClosedTab,
  computeWarmTabCounts,
  pushWarmTabCounts,
  type ClosedTab,
  type TaskLookupTask
} from './useTabStore.js'
import { _setTrpcClientSingleton } from '@slayzone/transport/client'

// The store persists its view-state slice through tRPC on a 500ms debounce. Once
// `isLoaded` flips true (which `_loadState` does), any slice change schedules that
// write — so without a stub the timer fires after the assertions and crashes the
// run on "tRPC client not ready".
_setTrpcClientSingleton({
  settings: { set: { mutate: async () => {} } }
} as never)

const store = useTabStore

function reset() {
  store.setState(store.getInitialState())
}

beforeEach(reset)

// Seed: focus on project A (task tab active), project B last viewed a task tab
// (tB) that is still open. This is the precondition for the home-icon bug.
function seedFocusedOnAWithBTaskOpen() {
  store.setState({
    tabs: [{ type: 'home' }, { type: 'task', taskId: 'tB', title: 'B-task' }],
    activeTabIndex: 1,
    selectedProjectId: 'pA',
    activeView: 'tabs',
    projectLastActiveTab: { pB: 'tB' },
    _taskLookup: {
      tasks: [{ id: 'tB', project_id: 'pB' }],
      projects: []
    }
  })
}

describe('useTabStore.selectProject', () => {
  // THE BUG: clicking project B's Home icon while focused on project A must land
  // on B's home (kanban) tab (index 0), NOT restore B's last task tab.
  test('home-icon click lands on home across project switch', () => {
    seedFocusedOnAWithBTaskOpen()
    store.getState().selectProject('pB', { home: true })
    const s = store.getState()
    expect(s.selectedProjectId, `selectedProjectId=${s.selectedProjectId}`).toBe('pB')
    expect(s.activeTabIndex, `activeTabIndex=${s.activeTabIndex} (want 0/home)`).toBe(0)
    expect(s.tabs[s.activeTabIndex]?.type, 'active tab is home').toBe('home')
  })

  // Restore behavior (rail/folder/search) must be preserved: a plain switch
  // (no home intent) restores project B's last active task tab.
  test('plain switch restores last active task tab', () => {
    seedFocusedOnAWithBTaskOpen()
    store.getState().selectProject('pB')
    const s = store.getState()
    expect(s.selectedProjectId, `selectedProjectId=${s.selectedProjectId}`).toBe('pB')
    expect(s.activeTabIndex, `activeTabIndex=${s.activeTabIndex} (want 1/restored task)`).toBe(1)
  })

  // Already on the project: any selectProject lands on home.
  test('selecting the already-active project lands on home', () => {
    seedFocusedOnAWithBTaskOpen()
    store.setState({ selectedProjectId: 'pB' })
    store.getState().selectProject('pB')
    expect(store.getState().activeTabIndex, 'activeTabIndex 0').toBe(0)
  })

  // Switch to a project whose last tab was home → home (unaffected by fix).
  test('plain switch where last tab was home lands on home', () => {
    seedFocusedOnAWithBTaskOpen()
    store.setState({ projectLastActiveTab: { pB: 'home' } })
    store.getState().selectProject('pB')
    expect(store.getState().activeTabIndex, 'activeTabIndex 0').toBe(0)
  })
})

describe('useTabStore.reopenClosedTab', () => {
  const REGULAR: TaskLookupTask = { id: 'tReg', title: 'Regular', project_id: 'pA' }
  const TEMP: TaskLookupTask = {
    id: 'tTemp',
    title: 'Terminal 1',
    project_id: 'pA',
    is_temporary: true
  }

  /** Home + a regular tab + a temporary tab, the temporary one active. */
  function seedRegularAndTempOpen() {
    store.setState({
      tabs: [
        { type: 'home' },
        { type: 'task', taskId: 'tReg', title: 'Regular' },
        { type: 'task', taskId: 'tTemp', title: 'Terminal 1', isTemporary: true }
      ],
      activeTabIndex: 2,
      _taskLookup: { tasks: [REGULAR, TEMP], projects: [] }
    })
  }

  /** Closing a temporary tab deletes its task, so the board — and the lookup — drop it. */
  function closeTempDiscarding(hubId?: string) {
    const index = store.getState().tabs.findIndex((t) => t.type === 'task' && t.taskId === 'tTemp')
    store.getState().closeTab(index, { hubId })
    const lookup = store.getState()._taskLookup
    store.setState({
      _taskLookup: { ...lookup, tasks: lookup.tasks.filter((t) => t.id !== 'tTemp') }
    })
  }

  function activeTaskTab() {
    const s = store.getState()
    const tab = s.tabs[s.activeTabIndex]
    return tab?.type === 'task' ? tab : null
  }

  test('closing a temporary tab stacks it with the hub its delete went to', () => {
    seedRegularAndTempOpen()
    closeTempDiscarding('hub-remote')
    const top = store.getState().closedTabs.at(-1)
    expect(top?.taskId, `top=${top?.taskId}`).toBe('tTemp')
    expect(top?.discarded?.hubId, `discarded=${JSON.stringify(top?.discarded)}`).toBe('hub-remote')
  })

  test('reopen restores a discarded temporary task on its hub, then opens it as temporary', async () => {
    seedRegularAndTempOpen()
    closeTempDiscarding('hub-remote')
    const restored: ClosedTab[] = []
    await store.getState().reopenClosedTab(async (tab) => {
      restored.push(tab)
      return TEMP
    })
    expect(restored.length, `restore calls=${restored.length}`).toBe(1)
    expect(restored[0].discarded?.hubId, 'restored on the hub it was deleted on').toBe('hub-remote')
    const tab = activeTaskTab()
    expect(tab?.taskId, `active=${tab?.taskId}`).toBe('tTemp')
    expect(tab?.isTemporary, 'reopened as a temporary tab').toBe(true)
    expect(store.getState().closedTabs.length, 'popped off the stack').toBe(0)
  })

  test('a discarded task gone for good is skipped for the tab closed before it', async () => {
    seedRegularAndTempOpen()
    store.getState().closeTab(1) // regular first…
    closeTempDiscarding() // …then the temporary one (default hub)
    await store.getState().reopenClosedTab(async () => null)
    expect(activeTaskTab()?.taskId, `active=${activeTaskTab()?.taskId}`).toBe('tReg')
    expect(store.getState().closedTabs.length, 'both entries consumed').toBe(0)
  })

  test('a failed restore keeps the entry on the stack and rethrows', async () => {
    seedRegularAndTempOpen()
    closeTempDiscarding('hub-down')
    const tabsBefore = store.getState().tabs
    let threw = false
    try {
      await store.getState().reopenClosedTab(async () => {
        throw new Error('hub unreachable')
      })
    } catch {
      threw = true
    }
    expect(threw, 'rethrows').toBeTruthy()
    expect(store.getState().closedTabs.at(-1)?.taskId, 'entry still on top').toBe('tTemp')
    expect(store.getState().tabs, 'no tab opened').toBe(tabsBefore)
  })

  test('without a restorer a discarded entry is skipped like any gone task', async () => {
    seedRegularAndTempOpen()
    store.getState().closeTab(1)
    closeTempDiscarding()
    await store.getState().reopenClosedTab()
    expect(activeTaskTab()?.taskId, `active=${activeTaskTab()?.taskId}`).toBe('tReg')
  })

  test('a discarded entry whose task is back (e.g. undo) opens without restoring', async () => {
    seedRegularAndTempOpen()
    closeTempDiscarding()
    const lookup = store.getState()._taskLookup
    store.setState({ _taskLookup: { ...lookup, tasks: [...lookup.tasks, TEMP] } })
    let calls = 0
    await store.getState().reopenClosedTab(async () => {
      calls++
      return TEMP
    })
    expect(calls, `restore calls=${calls}`).toBe(0)
    expect(activeTaskTab()?.taskId, `active=${activeTaskTab()?.taskId}`).toBe('tTemp')
  })

  test('a temporary tab closed without discarding stays reopenable while its task lives', async () => {
    seedRegularAndTempOpen()
    store.getState().closeTab(2)
    const top = store.getState().closedTabs.at(-1)
    expect(top?.taskId, `top=${JSON.stringify(top)}`).toBe('tTemp')
    expect(top?.discarded, `top=${JSON.stringify(top)}`).toBeFalsy()
    await store.getState().reopenClosedTab()
    expect(activeTaskTab()?.taskId, `active=${activeTaskTab()?.taskId}`).toBe('tTemp')
  })

  test('persisted entries: discard info survives, malformed discard info is dropped', () => {
    const tab = { type: 'task', taskId: 't', title: 'T' }
    expect(
      parseClosedTab({ ...tab, discarded: { hubId: 'h' } })?.discarded?.hubId,
      'hub kept'
    ).toBe('h')
    expect(
      !parseClosedTab({ ...tab, discarded: {} })?.discarded,
      'default-hub discard kept'
    ).toBeFalsy()
    expect(
      parseClosedTab({ ...tab, discarded: { hubId: 5 } })?.discarded,
      'bad hub dropped'
    ).toBeFalsy()
    expect(parseClosedTab({ ...tab, discarded: true })?.discarded, 'non-object dropped').toBeFalsy()
    expect(parseClosedTab({ ...tab, discarded: true })?.taskId, 'tab itself kept').toBe('t')
    expect(parseClosedTab({ type: 'home' }), 'non-task rejected').toBe(null)
  })
})

describe('computeWarmTabCounts', () => {
  // A renderer reload restores its task tabs before the task lookup loads. Pushing
  // the all-zero counts of that moment made the hub kill every warm agent and boot
  // them all again ~0.6s later (diagnostics 2026-10-25 08:31:36).
  test('restored task tabs before the lookup loads: no snapshot, not an empty one', () => {
    const tabs = [{ type: 'home' as const }, { type: 'task' as const, taskId: 't1', title: 'T1' }]
    expect(computeWarmTabCounts(tabs, { tasks: [], projects: [] }), 'not ready → null').toBe(null)
  })

  test('no task tabs at all: an empty snapshot (pool tears down)', () => {
    const counts = computeWarmTabCounts([{ type: 'home' }], { tasks: [], projects: [] })
    expect(counts, 'empty map').not.toBe(null)
    expect(counts?.size, 'empty map').toBe(0)
  })

  test('loaded lookup: counts per project, grouped by owning hub', () => {
    const tabs = [
      { type: 'task' as const, taskId: 't1', title: '1' },
      { type: 'task' as const, taskId: 't2', title: '2' },
      { type: 'task' as const, taskId: 't3', title: '3' }
    ]
    const counts = computeWarmTabCounts(tabs, {
      tasks: [
        { id: 't1', project_id: 'pA' },
        { id: 't2', project_id: 'pA' },
        { id: 't3', project_id: 'pB' }
      ] as TaskLookupTask[],
      projects: [{ id: 'pB', hubId: 'h2' }] as never
    })
    expect(counts, 'ready').not.toBe(null)
    expect(JSON.stringify(counts!.get(undefined)), 'default hub').toBe(JSON.stringify({ pA: 2 }))
    expect(JSON.stringify(counts!.get('h2')), 'owning hub').toBe(JSON.stringify({ pB: 1 }))
  })

  // ── explode arrangement persistence ─────────────────────────────────────────
  // The arrangement rides the same `viewState` slice as the rest of the view
  // state, so a renderer reload keeps a layout the user deliberately built.

  test('setExplodeArrangement updates order and minimized independently', () => {
    store.setState({ explodeOrder: ['a', 'b'], explodeMinimized: ['b'] })
    // Partial write: a drag changes only the order and must not clear the tray.
    store.getState().setExplodeArrangement({ order: ['b', 'a'] })
    let s = store.getState()
    expect(JSON.stringify(s.explodeOrder), `order=${JSON.stringify(s.explodeOrder)}`).toBe(
      '["b","a"]'
    )
    expect(JSON.stringify(s.explodeMinimized), 'minimized untouched by an order write').toBe(
      '["b"]'
    )

    store.getState().setExplodeArrangement({ minimized: [] })
    s = store.getState()
    expect(JSON.stringify(s.explodeOrder), 'order untouched by a minimized write').toBe('["b","a"]')
    expect(s.explodeMinimized.length, 'minimized cleared').toBe(0)
  })

  test('_loadState restores a persisted arrangement', () => {
    store.getState()._loadState({
      tabs: [],
      activeTabIndex: 0,
      selectedProjectId: '',
      explodeOrder: ['x', 'y'],
      explodeMinimized: ['y']
    })
    const s = store.getState()
    expect(JSON.stringify(s.explodeOrder), `order=${JSON.stringify(s.explodeOrder)}`).toBe(
      '["x","y"]'
    )
    expect(JSON.stringify(s.explodeMinimized), 'minimized restored').toBe('["y"]')
  })

  test('_loadState rejects malformed arrangement entries', () => {
    // This JSON lives on disk, so a non-string entry would otherwise flow straight
    // into layout as an undefined task id.
    store.getState()._loadState({
      tabs: [],
      activeTabIndex: 0,
      selectedProjectId: '',
      explodeOrder: ['ok', 42, null, 'fine'] as unknown as string[],
      explodeMinimized: 'not-an-array' as unknown as string[]
    })
    const s = store.getState()
    expect(
      JSON.stringify(s.explodeOrder),
      `non-string entries dropped, got ${JSON.stringify(s.explodeOrder)}`
    ).toBe('["ok","fine"]')
    expect(s.explodeMinimized.length, 'non-array falls back to empty').toBe(0)
  })
})

describe('pushWarmTabCounts', () => {
  /** A hub client whose `hub.describe` reports `scopes`; records every warm push. */
  function fakeHub(scopes: string[] | null) {
    const pushed: Record<string, number>[] = []
    const client = {
      hub: { describe: { query: async () => ({ scopes }) } },
      pty: {
        warmSetProjectTabCounts: {
          mutate: async (input: { counts: Record<string, number> }) => {
            pushed.push(input.counts)
          }
        }
      }
    }
    return { client: client as never, pushed }
  }

  // #164: a web session (read+tasks+agent) cannot call this — the scope gate refused
  // every push and logged an `authz.denied` line for it. Skip a hub that would refuse.
  test('a hub whose credential may not drive the warm pool is not pushed to', async () => {
    const local = fakeHub(null)
    const web = fakeHub(['read', 'tasks', 'agent'])
    const counts = new Map<string | undefined, Record<string, number>>([
      [undefined, { pA: 1 }],
      ['h2', { pB: 1 }]
    ])
    await pushWarmTabCounts(counts, local.client, (id) => (id === 'h2' ? web.client : null))
    expect(JSON.stringify(local.pushed), 'default hub pushed').toBe(JSON.stringify([{ pA: 1 }]))
    expect(web.pushed.length, 'scoped hub skipped').toBe(0)
  })

  test('no open task tabs: the default hub is cleared unless it would refuse', async () => {
    const full = fakeHub(['full'])
    await pushWarmTabCounts(new Map(), full.client, () => null)
    expect(JSON.stringify(full.pushed), 'cleared').toBe(JSON.stringify([{}]))
    const web = fakeHub(['read', 'tasks', 'agent'])
    await pushWarmTabCounts(new Map(), web.client, () => null)
    expect(web.pushed.length, 'scoped default hub skipped').toBe(0)
  })
})
