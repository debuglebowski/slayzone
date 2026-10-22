/**
 * Tab store unit tests
 * Run with: npx tsx packages/domains/settings/src/client/useTabStore.test.ts
 */

import { useTabStore, parseClosedTab, type ClosedTab, type TaskLookupTask } from './useTabStore.js'

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

console.log('Done')
