import { test, expect, seed, goHome, clickProject, projectBlob, resetApp} from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import { pressShortcut } from '../fixtures/shortcuts'

test.describe('Multi-project & persistence', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)

    // Create two distinct projects with tasks
    let projects = await s.getProjects()
    const hasAlpha = projects.some((p: { name: string }) => p.name === 'Alpha Project')
    const hasBeta = projects.some((p: { name: string }) => p.name === 'Beta Project')

    if (!hasAlpha) {
      const alpha = await s.createProject({ name: 'Alpha Project', color: '#ef4444', path: TEST_PROJECT_PATH })
      await s.createTask({ projectId: alpha.id, title: 'Alpha task one', status: 'todo' })
      await s.createTask({ projectId: alpha.id, title: 'Alpha task two', status: 'in_progress' })
    }
    if (!hasBeta) {
      const beta = await s.createProject({ name: 'Beta Project', color: '#3b82f6', path: TEST_PROJECT_PATH })
      await s.createTask({ projectId: beta.id, title: 'Beta task one', status: 'todo' })
      await s.createTask({ projectId: beta.id, title: 'Beta task two', status: 'done' })
    }
    await s.refreshData()
    await goHome(mainWindow)
    await expect(projectBlob(mainWindow, 'AL')).toBeVisible({ timeout: 5_000 })
  })

  test('switching projects shows correct tasks', async ({ mainWindow }) => {
    // Select Alpha
    await clickProject(mainWindow, 'AL')

    await expect(mainWindow.getByText('Alpha task one')).toBeVisible({ timeout: 5_000 })
    await expect(mainWindow.getByText('Beta task one')).not.toBeVisible()

    // Switch to Beta
    await clickProject(mainWindow, 'BE')

    await expect(mainWindow.getByText('Beta task one')).toBeVisible({ timeout: 5_000 })
    await expect(mainWindow.getByText('Alpha task one')).not.toBeVisible()
  })

  test('search finds tasks across projects', async ({ mainWindow }) => {
    await pressShortcut(mainWindow, 'search')

    const searchInput = mainWindow.getByPlaceholder('Search files, tasks, projects...')
    await expect(searchInput).toBeVisible({ timeout: 5_000 })
    await searchInput.fill('Beta task')

    // Should find Beta task even if currently viewing Alpha
    await expect(mainWindow.getByLabel('Tasks').getByText('Beta task one')).toBeVisible({ timeout: 3_000 })

    await mainWindow.keyboard.press('Escape')
  })

  test('search with no matching results', async ({ mainWindow }) => {
    await pressShortcut(mainWindow, 'search')

    const searchInput = mainWindow.getByPlaceholder('Search files, tasks, projects...')
    await expect(searchInput).toBeVisible({ timeout: 5_000 })
    await searchInput.fill('xyznonexistent999')

    // No results — the tasks/projects groups should not show matching items
    await expect(mainWindow.getByLabel('Tasks').getByText('xyznonexistent999')).not.toBeVisible()

    await mainWindow.keyboard.press('Escape')
  })

  test('empty kanban columns still render headers', async ({ mainWindow }) => {
    await clickProject(mainWindow, 'AL')

    // Alpha has tasks in todo and in_progress, but other columns should still have headers
    // Check that Inbox header exists (it should be rendered even if empty)
    await expect(mainWindow.locator('h3').getByText('Inbox', { exact: true })).toBeAttached({ timeout: 5_000 })
  })

  test('theme setting persists after refresh', async ({ mainWindow }) => {
    const s = seed(mainWindow)

    // Set dark theme via API
    await s.setTheme('dark')

    await expect(mainWindow.locator('html.dark')).toBeAttached({ timeout: 5_000 })

    // Refresh data (simulates re-render)
    await s.refreshData()

    await expect(mainWindow.locator('html.dark')).toBeAttached({ timeout: 5_000 })

    // Restore light theme
    await s.setTheme('light')
    await expect(mainWindow.locator('html.dark')).not.toBeAttached({ timeout: 5_000 })
  })
})
