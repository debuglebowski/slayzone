import { test, expect, seed, goHome, clickProject, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'

/**
 * A path that does not exist but that the computer is WILLING to look at.
 *
 * Derived from `TEST_PROJECT_PATH` (worker-scoped, under $HOME) rather than a
 * `/tmp` literal: `workspace.pathExists` runs on the computer that owns the
 * project's files, behind that computer's `allowedRoots` jail, and the local
 * computer's jail is `[$HOME]`. A `/tmp` path is refused before it is ever
 * stat'd, which surfaces as `reachable: false` — and the path guard treats "could
 * not ask" as explicitly NOT "missing", so the error UI never renders and this
 * file tested nothing. Assigned in `beforeAll` because the fixture rebinds
 * `TEST_PROJECT_PATH` per worker.
 */
let BAD_PATH: string

test.describe('Error states', () => {
  let projectAbbrev: string
  let projectId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    BAD_PATH = `${TEST_PROJECT_PATH}-does-not-exist`
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Bad Path', color: '#dc2626', path: BAD_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    projectId = p.id
    await s.refreshData()
    await goHome(mainWindow)
  })

  test('shows error UI when project path does not exist', async ({ mainWindow }) => {
    await clickProject(mainWindow, projectAbbrev)

    await expect(mainWindow.getByText('Project path not found')).toBeVisible({ timeout: 3_000 })
    await expect(mainWindow.locator('code').getByText(BAD_PATH)).toBeVisible()
    await expect(mainWindow.getByRole('button', { name: 'Update path' })).toBeVisible()
  })

  test('kanban is not visible during error state', async ({ mainWindow }) => {
    // Column headers should not be present
    await expect(mainWindow.locator('h3').getByText('Inbox', { exact: true })).not.toBeVisible()
    await expect(mainWindow.locator('h3').getByText('Todo', { exact: true })).not.toBeVisible()
  })

  test('fixing path restores kanban', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    await s.updateProject({ id: projectId, path: TEST_PROJECT_PATH })
    await s.refreshData()

    await expect(mainWindow.getByText('Project path not found')).not.toBeVisible({ timeout: 5_000 })
    // Kanban columns should reappear
    await expect(mainWindow.locator('h3').getByText('Inbox', { exact: true })).toBeVisible({
      timeout: 5_000
    })
  })
})
