import { test, expect, seed, goHome, clickProject, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import { pressShortcut } from '../fixtures/shortcuts'

test.describe('Navigation & tabs', () => {
  let projectAbbrev: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Nav Test', color: '#06b6d4', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()

    await s.createTask({ projectId: p.id, title: 'Nav search task', status: 'in_progress' })
    await s.createTask({ projectId: p.id, title: 'Nav detail task', status: 'in_progress' })
    await s.createTask({ projectId: p.id, title: 'Nav open task', status: 'in_progress' })
    await s.refreshData()

    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.locator('h3').getByText('Inbox', { exact: true })).toBeVisible({ timeout: 5_000 })
  })

  test('search shortcut opens search dialog', async ({ mainWindow }) => {
    await pressShortcut(mainWindow, 'search')
    await expect(mainWindow.getByPlaceholder('Search files, tasks, projects...')).toBeVisible({
      timeout: 3_000,
    })
  })

  test('search finds tasks', async ({ mainWindow }) => {
    const searchInput = mainWindow.getByPlaceholder('Search files, tasks, projects...')
    await searchInput.fill('Nav search')
    await expect(mainWindow.locator('[cmdk-item]').getByText('Nav search task')).toBeVisible({ timeout: 3_000 })
    await mainWindow.keyboard.press('Escape')
  })

  test('search shortcut selects result and navigates', async ({ mainWindow }) => {
    await pressShortcut(mainWindow, 'search')
    const searchInput = mainWindow.getByPlaceholder('Search files, tasks, projects...')
    await searchInput.fill('Nav detail task')
    await expect(mainWindow.locator('[cmdk-item]').getByText('Nav detail task')).toBeVisible({ timeout: 3_000 })

    // Click the specific result to avoid selecting wrong task
    await mainWindow.locator('[cmdk-item]').getByText('Nav detail task').click()

    // Use evaluate to find visible input (hidden tab inputs may exist in DOM)
    // Poll until the task detail input appears with the expected value
    await expect.poll(() => mainWindow.evaluate(() => {
      const inputs = document.querySelectorAll('input')
      for (const input of inputs) {
        if (input.offsetParent !== null && input.value && !input.closest('.invisible')) return input.value
      }
      return null
    }), { timeout: 5_000 }).toBe('Nav detail task')
  })

  test('open task from kanban and close tab', async ({ mainWindow }) => {
    await mainWindow.keyboard.press('Escape')
    await expect(mainWindow.getByPlaceholder('Search files, tasks, projects...')).not.toBeVisible()

    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.locator('h3').getByText('Inbox', { exact: true })).toBeVisible({ timeout: 5_000 })

    await mainWindow.getByText('Nav open task').first().click()
    await expect.poll(() => mainWindow.evaluate(() => {
      const inputs = document.querySelectorAll('input')
      for (const input of inputs) {
        if (input.offsetParent !== null && input.value && !input.closest('.invisible')) return input.value
      }
      return null
    }), { timeout: 5_000 }).toBe('Nav open task')

    // Go back to home instead of Cmd+W (which closes Electron window)
    await goHome(mainWindow)
    await expect(mainWindow.locator('h3').getByText('Inbox', { exact: true })).toBeVisible({ timeout: 5_000 })
  })
})
