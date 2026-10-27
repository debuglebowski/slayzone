/**
 * Dialog store unit tests
 */
import { beforeEach, expect, test } from 'vitest'

import { useDialogStore } from './useDialogStore.js'

const store = useDialogStore

function reset() {
  store.setState(store.getInitialState())
}

beforeEach(reset)

test('starts with all dialogs closed', () => {
  const s = store.getState()
  expect(s.createTaskOpen, 'createTaskOpen').toBeFalsy()
  expect(s.editingTask, 'editingTask').toBeFalsy()
  expect(s.deletingTask, 'deletingTask').toBeFalsy()
  expect(s.createProjectOpen, 'createProjectOpen').toBeFalsy()
  expect(s.deletingProject, 'deletingProject').toBeFalsy()
  expect(s.onboardingOpen, 'onboardingOpen').toBeFalsy()
  expect(s.changelogOpen, 'changelogOpen').toBeFalsy()
  expect(s.searchOpen, 'searchOpen').toBeFalsy()
  expect(s.completeTaskDialogOpen, 'completeTaskDialogOpen').toBeFalsy()
  expect(s.showAnimatedTour, 'showAnimatedTour').toBeFalsy()
})

test('openCreateTask with no defaults', () => {
  store.getState().openCreateTask()
  const s = store.getState()
  expect(s.createTaskOpen, 'open').toBeTruthy()
  expect(Object.keys(s.createTaskDraft).length, 'draft empty').toBe(0)
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
  expect(s.createTaskOpen, 'open').toBeTruthy()
  expect(s.createTaskDraft.projectId, 'projectId').toBe('project-1')
  expect(s.createTaskDraft.title, 'title').toBe('Link: Docs')
  expect(s.createTaskDraft.description, 'description').toBe('https://example.com/docs')
  expect(s.createTaskDraft.status, 'status').toBe('todo')
  expect(s.createTaskDraft.priority, 'priority').toBe(2)
})

test('closeCreateTask resets draft', () => {
  store.getState().openCreateTask({ priority: 3 })
  store.getState().closeCreateTask()
  const s = store.getState()
  expect(s.createTaskOpen, 'closed').toBeFalsy()
  expect(Object.keys(s.createTaskDraft).length, 'draft reset').toBe(0)
})

test('openEditTask sets task payload', () => {
  const task = { id: '1', title: 'test' } as never
  store.getState().openEditTask(task)
  expect(store.getState().editingTask?.id, 'task set').toBe('1')
})

test('closeEditTask clears payload', () => {
  store.getState().openEditTask({ id: '1' } as never)
  store.getState().closeEditTask()
  expect(store.getState().editingTask, 'cleared').toBeFalsy()
})

test('openDeleteTask sets task payload', () => {
  const task = { id: '2', title: 'del' } as never
  store.getState().openDeleteTask(task)
  expect(store.getState().deletingTask?.id, 'task set').toBe('2')
})

test('closeDeleteTask clears payload', () => {
  store.getState().openDeleteTask({ id: '2' } as never)
  store.getState().closeDeleteTask()
  expect(store.getState().deletingTask, 'cleared').toBeFalsy()
})

test('openDeleteProject sets project payload', () => {
  const project = { id: 'p1', name: 'proj' } as never
  store.getState().openDeleteProject(project)
  expect(store.getState().deletingProject?.id, 'project set').toBe('p1')
})

test('closeDeleteProject clears payload', () => {
  store.getState().openDeleteProject({ id: 'p1' } as never)
  store.getState().closeDeleteProject()
  expect(store.getState().deletingProject, 'cleared').toBeFalsy()
})

test('boolean dialogs toggle independently', () => {
  store.getState().openSearch()
  store.getState().openChangelog()
  store.getState().openOnboarding()
  const s = store.getState()
  expect(s.searchOpen, 'search').toBeTruthy()
  expect(s.changelogOpen, 'changelog').toBeTruthy()
  expect(s.onboardingOpen, 'onboarding').toBeTruthy()
  expect(s.completeTaskDialogOpen, 'completeTask still closed').toBeFalsy()
  expect(s.showAnimatedTour, 'tour still closed').toBeFalsy()
})

test('closing one dialog does not affect others', () => {
  store.getState().openSearch()
  store.getState().openChangelog()
  store.getState().closeSearch()
  expect(store.getState().searchOpen, 'search closed').toBeFalsy()
  expect(store.getState().changelogOpen, 'changelog still open').toBeTruthy()
})

test('createProject open/close', () => {
  store.getState().openCreateProject()
  expect(store.getState().createProjectOpen, 'open').toBeTruthy()
  store.getState().closeCreateProject()
  expect(store.getState().createProjectOpen, 'closed').toBeFalsy()
})

test('completeTaskDialog open/close', () => {
  store.getState().openCompleteTaskDialog()
  expect(store.getState().completeTaskDialogOpen, 'open').toBeTruthy()
  store.getState().closeCompleteTaskDialog()
  expect(store.getState().completeTaskDialogOpen, 'closed').toBeFalsy()
})

test('animatedTour open/close', () => {
  store.getState().openAnimatedTour()
  expect(store.getState().showAnimatedTour, 'open').toBeTruthy()
  store.getState().closeAnimatedTour()
  expect(store.getState().showAnimatedTour, 'closed').toBeFalsy()
})
