/**
 * Tab store unit tests
 * Run with: npx tsx packages/domains/settings/src/client/useTabStore.test.ts
 */

import { useTabStore } from './useTabStore.js'

const store = useTabStore

function reset() {
  store.setState(store.getInitialState())
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`FAIL: ${msg}`)
}

function test(name: string, fn: () => void) {
  reset()
  try {
    fn()
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
    tabs: [
      { type: 'home' },
      { type: 'task', taskId: 'tB', title: 'B-task' }
    ],
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
test('home-icon click lands on home across project switch', () => {
  seedFocusedOnAWithBTaskOpen()
  store.getState().selectProject('pB', { home: true })
  const s = store.getState()
  assert(s.selectedProjectId === 'pB', `selectedProjectId=${s.selectedProjectId}`)
  assert(s.activeTabIndex === 0, `activeTabIndex=${s.activeTabIndex} (want 0/home)`)
  assert(s.tabs[s.activeTabIndex]?.type === 'home', 'active tab is home')
})

// Restore behavior (rail/folder/search) must be preserved: a plain switch
// (no home intent) restores project B's last active task tab.
test('plain switch restores last active task tab', () => {
  seedFocusedOnAWithBTaskOpen()
  store.getState().selectProject('pB')
  const s = store.getState()
  assert(s.selectedProjectId === 'pB', `selectedProjectId=${s.selectedProjectId}`)
  assert(s.activeTabIndex === 1, `activeTabIndex=${s.activeTabIndex} (want 1/restored task)`)
})

// Already on the project: any selectProject lands on home.
test('selecting the already-active project lands on home', () => {
  seedFocusedOnAWithBTaskOpen()
  store.setState({ selectedProjectId: 'pB' })
  store.getState().selectProject('pB')
  assert(store.getState().activeTabIndex === 0, 'activeTabIndex 0')
})

// Switch to a project whose last tab was home → home (unaffected by fix).
test('plain switch where last tab was home lands on home', () => {
  seedFocusedOnAWithBTaskOpen()
  store.setState({ projectLastActiveTab: { pB: 'home' } })
  store.getState().selectProject('pB')
  assert(store.getState().activeTabIndex === 0, 'activeTabIndex 0')
})

console.log('Done')
