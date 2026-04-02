/**
 * Dialog store unit tests
 * Run with: npx tsx packages/domains/settings/src/client/useDialogStore.test.ts
 */

import { useDialogStore } from './useDialogStore.js'

const store = useDialogStore

function reset() {
  store.setState(store.getInitialState())
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`FAIL: ${msg}`)
}

function test(name: string, fn: () => void) {
  reset()
  try { fn(); console.log(`  ✓ ${name}`) }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); process.exitCode = 1 }
}

console.log('useDialogStore')

test('starts with all dialogs closed', () => {
  const s = store.getState()
  assert(!s.createTaskOpen, 'createTaskOpen')
  assert(!s.editingTask, 'editingTask')
  assert(!s.deletingTask, 'deletingTask')
  assert(!s.createProjectOpen, 'createProjectOpen')
  assert(!s.deletingProject, 'deletingProject')
  assert(!s.onboardingOpen, 'onboardingOpen')
  assert(!s.changelogOpen, 'changelogOpen')
  assert(!s.searchOpen, 'searchOpen')
  assert(!s.completeTaskDialogOpen, 'completeTaskDialogOpen')
  assert(!s.showAnimatedTour, 'showAnimatedTour')
})

test('openCreateTask with no defaults', () => {
  store.getState().openCreateTask()
  const s = store.getState()
  assert(s.createTaskOpen, 'open')
  assert(Object.keys(s.createTaskDraft).length === 0, 'draft empty')
})

test('openCreateTask with draft', () => {
  store.getState().openCreateTask({
    projectId: 'project-1',
    title: 'Link: Docs',
    description: 'https://example.com/docs',
    status: 'todo' as never,
    priority: 2
  })
  const s = store.getState()
  assert(s.createTaskOpen, 'open')
  assert(s.createTaskDraft.projectId === 'project-1', 'projectId')
  assert(s.createTaskDraft.title === 'Link: Docs', 'title')
  assert(s.createTaskDraft.description === 'https://example.com/docs', 'description')
  assert(s.createTaskDraft.status === 'todo', 'status')
  assert(s.createTaskDraft.priority === 2, 'priority')
})

test('closeCreateTask resets draft', () => {
  store.getState().openCreateTask({ priority: 3 })
  store.getState().closeCreateTask()
  const s = store.getState()
  assert(!s.createTaskOpen, 'closed')
  assert(Object.keys(s.createTaskDraft).length === 0, 'draft reset')
})

test('openEditTask sets task payload', () => {
  const task = { id: '1', title: 'test' } as never
  store.getState().openEditTask(task)
  assert(store.getState().editingTask?.id === '1', 'task set')
})

test('closeEditTask clears payload', () => {
  store.getState().openEditTask({ id: '1' } as never)
  store.getState().closeEditTask()
  assert(!store.getState().editingTask, 'cleared')
})

test('openDeleteTask sets task payload', () => {
  const task = { id: '2', title: 'del' } as never
  store.getState().openDeleteTask(task)
  assert(store.getState().deletingTask?.id === '2', 'task set')
})

test('closeDeleteTask clears payload', () => {
  store.getState().openDeleteTask({ id: '2' } as never)
  store.getState().closeDeleteTask()
  assert(!store.getState().deletingTask, 'cleared')
})

test('openDeleteProject sets project payload', () => {
  const project = { id: 'p1', name: 'proj' } as never
  store.getState().openDeleteProject(project)
  assert(store.getState().deletingProject?.id === 'p1', 'project set')
})

test('closeDeleteProject clears payload', () => {
  store.getState().openDeleteProject({ id: 'p1' } as never)
  store.getState().closeDeleteProject()
  assert(!store.getState().deletingProject, 'cleared')
})

test('boolean dialogs toggle independently', () => {
  store.getState().openSearch()
  store.getState().openChangelog()
  store.getState().openOnboarding()
  const s = store.getState()
  assert(s.searchOpen, 'search')
  assert(s.changelogOpen, 'changelog')
  assert(s.onboardingOpen, 'onboarding')
  assert(!s.completeTaskDialogOpen, 'completeTask still closed')
  assert(!s.showAnimatedTour, 'tour still closed')
})

test('closing one dialog does not affect others', () => {
  store.getState().openSearch()
  store.getState().openChangelog()
  store.getState().closeSearch()
  assert(!store.getState().searchOpen, 'search closed')
  assert(store.getState().changelogOpen, 'changelog still open')
})

test('createProject open/close', () => {
  store.getState().openCreateProject()
  assert(store.getState().createProjectOpen, 'open')
  store.getState().closeCreateProject()
  assert(!store.getState().createProjectOpen, 'closed')
})

test('completeTaskDialog open/close', () => {
  store.getState().openCompleteTaskDialog()
  assert(store.getState().completeTaskDialogOpen, 'open')
  store.getState().closeCompleteTaskDialog()
  assert(!store.getState().completeTaskDialogOpen, 'closed')
})

test('animatedTour open/close', () => {
  store.getState().openAnimatedTour()
  assert(store.getState().showAnimatedTour, 'open')
  store.getState().closeAnimatedTour()
  assert(!store.getState().showAnimatedTour, 'closed')
})

console.log('Done')
