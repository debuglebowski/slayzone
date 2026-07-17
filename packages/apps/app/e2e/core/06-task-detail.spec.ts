import { test, expect, seed, goHome, clickProject, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'

test.describe('Task detail page', () => {
  let taskTitle = 'Detail test task'
  let projectAbbrev: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Detail Test',
      color: '#f59e0b',
      path: TEST_PROJECT_PATH
    })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    await s.createTask({ projectId: p.id, title: taskTitle, status: 'in_progress' })
    await s.refreshData()

    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.getByText(taskTitle).first()).toBeVisible({ timeout: 5_000 })
  })

  test('click task card opens detail tab', async ({ mainWindow }) => {
    await mainWindow.getByText(taskTitle).first().click()

    // Title input has no explicit type attr, so use plain input selector
    const titleInput = mainWindow.locator('input').first()
    await expect(titleInput).toHaveValue(taskTitle, { timeout: 5_000 })
  })

  test('edit title inline', async ({ mainWindow }) => {
    const titleInput = mainWindow.locator('input').first()
    await titleInput.click()
    await titleInput.fill('Updated detail title')
    await titleInput.press('Enter')

    await expect(titleInput).toHaveValue('Updated detail title')
    taskTitle = 'Updated detail title'
  })

  test('task detail page renders title correctly', async ({ mainWindow }) => {
    // Verify we're on the detail page with the correct title
    const titleInput = mainWindow.locator('input').first()
    await expect(titleInput).toHaveValue(taskTitle)
  })

  test('metadata sidebar renders + RunnerCard shows the local default (no runners enrolled)', async ({
    mainWindow
  }) => {
    // The TaskMetadataSidebar lives in the settings panel's pinned Details region
    // in normal mode. With runner mode off (default — no runners enrolled), the new
    // RunnerCard degrades to a muted "runs locally" note rather than a live select.
    const details = mainWindow.getByTestId('settings-details-pinned').last()
    await expect(details).toBeVisible({ timeout: 5_000 })
    // Sidebar still renders its existing sections.
    await expect(details.getByText('Runner', { exact: true })).toBeVisible({ timeout: 5_000 })
    await expect(details.getByText('No runners — runs locally')).toBeVisible({ timeout: 5_000 })
  })

  test('go back to kanban', async ({ mainWindow }) => {
    await goHome(mainWindow)
    // Verify kanban is visible — check for any column header
    const inbox = mainWindow.locator('h3').getByText('Inbox', { exact: true })
    await inbox.scrollIntoViewIfNeeded({ timeout: 5_000 })
    await expect(inbox).toBeVisible({ timeout: 5_000 })
  })
})
