/**
 * Tab store unit tests
 * Run with: npx tsx packages/domains/settings/src/client/useTabStore.test.ts
 */

import { useTabStore } from './useTabStore.js'
import { _setTrpcClientSingleton } from '@slayzone/transport/client'

// The store persists its view-state slice through tRPC on a 500ms debounce. Once
// `isLoaded` flips true (which `_loadState` does), any slice change schedules that
// write — so without a stub the timer fires after the assertions and crashes the
// run on "tRPC client not ready". Stub it and assert the write instead.
const settingsWrites: Array<{ key: string; value: string }> = []
_setTrpcClientSingleton({
  settings: {
    set: {
      mutate: async (input: { key: string; value: string }) => {
        settingsWrites.push(input)
      }
    }
  }
} as never)

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

// ── explode arrangement persistence ─────────────────────────────────────────
// The arrangement rides the same `viewState` slice as the rest of the view
// state, so a renderer reload keeps a layout the user deliberately built.

test('setExplodeArrangement updates order and minimized independently', () => {
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

test('_loadState restores a persisted arrangement', () => {
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
  assert(
    JSON.stringify(s.explodeOrder) === '["ok","fine"]',
    `non-string entries dropped, got ${JSON.stringify(s.explodeOrder)}`
  )
  assert(s.explodeMinimized.length === 0, 'non-array falls back to empty')
})

console.log('Done')
