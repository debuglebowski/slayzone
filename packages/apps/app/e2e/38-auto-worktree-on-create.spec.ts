import { test, expect, seed, TEST_PROJECT_PATH, resetApp, ensureGitRepo} from './fixtures/electron'
import path from 'path'

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

test.describe('Auto worktree on task create', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    ensureGitRepo(TEST_PROJECT_PATH)
    const s = seed(mainWindow)
    await s.setSetting('worktree_base_path', '')
  })

  test('creates worktree when global setting is enabled', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const project = await s.createProject({
      name: 'Auto WT Global On',
      color: '#22c55e',
      path: TEST_PROJECT_PATH
    })
    await s.setSetting('auto_create_worktree_on_task_create', '1')

    const title = `Auto WT Global ${Date.now()}`
    const created = await s.createTask({
      projectId: project.id,
      title,
      status: 'todo'
    })

    const expectedBranch = slugify(title)
    await expect
      .poll(async () => {
        const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), created.id)
        return task?.worktree_path ?? null
      })
      .toBe(path.join(path.dirname(TEST_PROJECT_PATH), expectedBranch))
  })

  test('project override off disables auto-create even when global is on', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const project = await s.createProject({
      name: 'Auto WT Override Off',
      color: '#f97316',
      path: TEST_PROJECT_PATH
    })
    await s.setSetting('auto_create_worktree_on_task_create', '1')
    await s.updateProject({ id: project.id, autoCreateWorktreeOnTaskCreate: false })

    const created = await s.createTask({
      projectId: project.id,
      title: `Override Off ${Date.now()}`,
      status: 'todo'
    })

    const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), created.id)
    expect(task?.worktree_path).toBeNull()
  })

  test('project override on enables auto-create even when global is off', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const project = await s.createProject({
      name: 'Auto WT Override On',
      color: '#0ea5e9',
      path: TEST_PROJECT_PATH
    })
    await s.setSetting('auto_create_worktree_on_task_create', '0')
    await s.updateProject({ id: project.id, autoCreateWorktreeOnTaskCreate: true })

    const title = `Override On ${Date.now()}`
    const created = await s.createTask({
      projectId: project.id,
      title,
      status: 'todo'
    })

    const expectedBranch = slugify(title)
    await expect
      .poll(async () => {
        const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), created.id)
        return task?.worktree_path ?? null
      })
      .toBe(path.join(path.dirname(TEST_PROJECT_PATH), expectedBranch))
  })
})
