/**
 * Tab store unit tests
 * Run with: npx tsx packages/domains/settings/src/client/useTabStore.test.ts
 */

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

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`FAIL: ${msg}`)
}

async function test(name: string, fn: () => void | Promise<void>) {
  reset()
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`)
    process.exitCode = 1
  }
}

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

console.log('useTabStore.selectProject')

// THE BUG: clicking project B's Home icon while focused on project A must land
// on B's home (kanban) tab (index 0), NOT restore B's last task tab.
await test('home-icon click lands on home across project switch', () => {
  seedFocusedOnAWithBTaskOpen()
  store.getState().selectProject('pB', { home: true })
  const s = store.getState()
  assert(s.selectedProjectId === 'pB', `selectedProjectId=${s.selectedProjectId}`)
  assert(s.activeTabIndex === 0, `activeTabIndex=${s.activeTabIndex} (want 0/home)`)
  assert(s.tabs[s.activeTabIndex]?.type === 'home', 'active tab is home')
})

// Restore behavior (rail/folder/search) must be preserved: a plain switch
// (no home intent) restores project B's last active task tab.
await test('plain switch restores last active task tab', () => {
  seedFocusedOnAWithBTaskOpen()
  store.getState().selectProject('pB')
  const s = store.getState()
  assert(s.selectedProjectId === 'pB', `selectedProjectId=${s.selectedProjectId}`)
  assert(s.activeTabIndex === 1, `activeTabIndex=${s.activeTabIndex} (want 1/restored task)`)
})

// Already on the project: any selectProject lands on home.
await test('selecting the already-active project lands on home', () => {
  seedFocusedOnAWithBTaskOpen()
  store.setState({ selectedProjectId: 'pB' })
  store.getState().selectProject('pB')
  assert(store.getState().activeTabIndex === 0, 'activeTabIndex 0')
})

// Switch to a project whose last tab was home → home (unaffected by fix).
await test('plain switch where last tab was home lands on home', () => {
  seedFocusedOnAWithBTaskOpen()
  store.setState({ projectLastActiveTab: { pB: 'home' } })
  store.getState().selectProject('pB')
  assert(store.getState().activeTabIndex === 0, 'activeTabIndex 0')
})

console.log('useTabStore.reopenClosedTab')

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

await test('closing a temporary tab stacks it with the hub its delete went to', () => {
  seedRegularAndTempOpen()
  closeTempDiscarding('hub-remote')
  const top = store.getState().closedTabs.at(-1)
  assert(top?.taskId === 'tTemp', `top=${top?.taskId}`)
  assert(top?.discarded?.hubId === 'hub-remote', `discarded=${JSON.stringify(top?.discarded)}`)
})

await test('reopen restores a discarded temporary task on its hub, then opens it as temporary', async () => {
  seedRegularAndTempOpen()
  closeTempDiscarding('hub-remote')
  const restored: ClosedTab[] = []
  await store.getState().reopenClosedTab(async (tab) => {
    restored.push(tab)
    return TEMP
  })
  assert(restored.length === 1, `restore calls=${restored.length}`)
  assert(restored[0].discarded?.hubId === 'hub-remote', 'restored on the hub it was deleted on')
  const tab = activeTaskTab()
  assert(tab?.taskId === 'tTemp', `active=${tab?.taskId}`)
  assert(tab?.isTemporary === true, 'reopened as a temporary tab')
  assert(store.getState().closedTabs.length === 0, 'popped off the stack')
})

await test('a discarded task gone for good is skipped for the tab closed before it', async () => {
  seedRegularAndTempOpen()
  store.getState().closeTab(1) // regular first…
  closeTempDiscarding() // …then the temporary one (default hub)
  await store.getState().reopenClosedTab(async () => null)
  assert(activeTaskTab()?.taskId === 'tReg', `active=${activeTaskTab()?.taskId}`)
  assert(store.getState().closedTabs.length === 0, 'both entries consumed')
})

await test('a failed restore keeps the entry on the stack and rethrows', async () => {
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
  assert(threw, 'rethrows')
  assert(store.getState().closedTabs.at(-1)?.taskId === 'tTemp', 'entry still on top')
  assert(store.getState().tabs === tabsBefore, 'no tab opened')
})

await test('without a restorer a discarded entry is skipped like any gone task', async () => {
  seedRegularAndTempOpen()
  store.getState().closeTab(1)
  closeTempDiscarding()
  await store.getState().reopenClosedTab()
  assert(activeTaskTab()?.taskId === 'tReg', `active=${activeTaskTab()?.taskId}`)
})

await test('a discarded entry whose task is back (e.g. undo) opens without restoring', async () => {
  seedRegularAndTempOpen()
  closeTempDiscarding()
  const lookup = store.getState()._taskLookup
  store.setState({ _taskLookup: { ...lookup, tasks: [...lookup.tasks, TEMP] } })
  let calls = 0
  await store.getState().reopenClosedTab(async () => {
    calls++
    return TEMP
  })
  assert(calls === 0, `restore calls=${calls}`)
  assert(activeTaskTab()?.taskId === 'tTemp', `active=${activeTaskTab()?.taskId}`)
})

await test('a temporary tab closed without discarding stays reopenable while its task lives', async () => {
  seedRegularAndTempOpen()
  store.getState().closeTab(2)
  const top = store.getState().closedTabs.at(-1)
  assert(top?.taskId === 'tTemp' && !top.discarded, `top=${JSON.stringify(top)}`)
  await store.getState().reopenClosedTab()
  assert(activeTaskTab()?.taskId === 'tTemp', `active=${activeTaskTab()?.taskId}`)
})

await test('persisted entries: discard info survives, malformed discard info is dropped', () => {
  const tab = { type: 'task', taskId: 't', title: 'T' }
  assert(
    parseClosedTab({ ...tab, discarded: { hubId: 'h' } })?.discarded?.hubId === 'h',
    'hub kept'
  )
  assert(!!parseClosedTab({ ...tab, discarded: {} })?.discarded, 'default-hub discard kept')
  assert(!parseClosedTab({ ...tab, discarded: { hubId: 5 } })?.discarded, 'bad hub dropped')
  assert(!parseClosedTab({ ...tab, discarded: true })?.discarded, 'non-object dropped')
  assert(parseClosedTab({ ...tab, discarded: true })?.taskId === 't', 'tab itself kept')
  assert(parseClosedTab({ type: 'home' }) === null, 'non-task rejected')
})

console.log('computeWarmTabCounts')

// A renderer reload restores its task tabs before the task lookup loads. Pushing
// the all-zero counts of that moment made the hub kill every warm agent and boot
// them all again ~0.6s later (diagnostics 2026-10-25 08:31:36).
await test('restored task tabs before the lookup loads: no snapshot, not an empty one', () => {
  const tabs = [{ type: 'home' as const }, { type: 'task' as const, taskId: 't1', title: 'T1' }]
  assert(computeWarmTabCounts(tabs, { tasks: [], projects: [] }) === null, 'not ready → null')
})

await test('no task tabs at all: an empty snapshot (pool tears down)', () => {
  const counts = computeWarmTabCounts([{ type: 'home' }], { tasks: [], projects: [] })
  assert(counts !== null && counts.size === 0, 'empty map')
})

await test('loaded lookup: counts per project, grouped by owning hub', () => {
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
  assert(counts !== null, 'ready')
  assert(JSON.stringify(counts!.get(undefined)) === JSON.stringify({ pA: 2 }), 'default hub')
  assert(JSON.stringify(counts!.get('h2')) === JSON.stringify({ pB: 1 }), 'owning hub')
})

// ── explode arrangement persistence ─────────────────────────────────────────
// The arrangement rides the same `viewState` slice as the rest of the view
// state, so a renderer reload keeps a layout the user deliberately built.

await test('setExplodeArrangement updates order and minimized independently', () => {
  store.setState({ explodeOrder: ['a', 'b'], explodeMinimized: ['b'] })
  // Partial write: a drag changes only the order and must not clear the tray.
  store.getState().setExplodeArrangement({ order: ['b', 'a'] })
  let s = store.getState()
  assert(JSON.stringify(s.explodeOrder) === '["b","a"]', `order=${JSON.stringify(s.explodeOrder)}`)
  assert(JSON.stringify(s.explodeMinimized) === '["b"]', 'minimized untouched by an order write')

  store.getState().setExplodeArrangement({ minimized: [] })
  s = store.getState()
  assert(JSON.stringify(s.explodeOrder) === '["b","a"]', 'order untouched by a minimized write')
  assert(s.explodeMinimized.length === 0, 'minimized cleared')
})

await test('_loadState restores a persisted arrangement', () => {
  store.getState()._loadState({
    tabs: [],
    activeTabIndex: 0,
    selectedProjectId: '',
    explodeOrder: ['x', 'y'],
    explodeMinimized: ['y']
  })
  const s = store.getState()
  assert(JSON.stringify(s.explodeOrder) === '["x","y"]', `order=${JSON.stringify(s.explodeOrder)}`)
  assert(JSON.stringify(s.explodeMinimized) === '["y"]', 'minimized restored')
})

await test('_loadState rejects malformed arrangement entries', () => {
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
  assert(
    JSON.stringify(s.explodeOrder) === '["ok","fine"]',
    `non-string entries dropped, got ${JSON.stringify(s.explodeOrder)}`
  )
  assert(s.explodeMinimized.length === 0, 'non-array falls back to empty')
})

console.log('pushWarmTabCounts')

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
await test('a hub whose credential may not drive the warm pool is not pushed to', async () => {
  const local = fakeHub(null)
  const web = fakeHub(['read', 'tasks', 'agent'])
  const counts = new Map<string | undefined, Record<string, number>>([
    [undefined, { pA: 1 }],
    ['h2', { pB: 1 }]
  ])
  await pushWarmTabCounts(counts, local.client, (id) => (id === 'h2' ? web.client : null))
  assert(JSON.stringify(local.pushed) === JSON.stringify([{ pA: 1 }]), 'default hub pushed')
  assert(web.pushed.length === 0, 'scoped hub skipped')
})

await test('no open task tabs: the default hub is cleared unless it would refuse', async () => {
  const full = fakeHub(['full'])
  await pushWarmTabCounts(new Map(), full.client, () => null)
  assert(JSON.stringify(full.pushed) === JSON.stringify([{}]), 'cleared')
  const web = fakeHub(['read', 'tasks', 'agent'])
  await pushWarmTabCounts(new Map(), web.client, () => null)
  assert(web.pushed.length === 0, 'scoped default hub skipped')
})

console.log('Done')
