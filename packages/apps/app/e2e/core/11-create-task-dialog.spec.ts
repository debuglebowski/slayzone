import { test, expect, seed, goHome, clickProject, resetApp} from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'

test.describe('Create task dialog & metadata editing', () => {
  let projectAbbrev: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Dialog Test', color: '#3b82f6', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    await s.refreshData()
    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.locator('h3').getByText('Inbox', { exact: true })).toBeVisible({ timeout: 5_000 })
  })

  test('Cmd+N opens create task dialog', async ({ mainWindow }) => {
    await mainWindow.keyboard.press('Meta+n')
    await expect(mainWindow.getByText('Create Task')).toBeVisible({ timeout: 3_000 })
  })

  test('fill and submit create task form', async ({ mainWindow }) => {
    // Title
    const titleInput = mainWindow.locator('input[name="title"]')
    await titleInput.fill('Dialog created task')

    // Status — Radix Select, click trigger then item
    const statusTrigger = mainWindow.locator('form').getByRole('combobox').first()
    await statusTrigger.click()
    await mainWindow.getByRole('option', { name: 'In Progress' }).click()

    // Priority — second Radix Select
    const priorityTrigger = mainWindow.locator('form').getByRole('combobox').nth(1)
    await priorityTrigger.click()
    await mainWindow.getByRole('option', { name: 'Urgent' }).click()

    // Submit
    await mainWindow.locator('button[type="submit"]').filter({ hasText: 'Create' }).click()
    await expect(mainWindow.getByText('Create Task')).not.toBeVisible({ timeout: 5_000 })
  })

  test('created task appears on kanban', async ({ mainWindow }) => {
    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    // Toast may also include the title — scope to the kanban card.
    await expect(mainWindow.getByRole('button', { name: 'Dialog created task' })).toBeVisible({ timeout: 5_000 })
  })

  test('change status in task detail metadata sidebar', async ({ mainWindow }) => {
    // Open task detail — click the kanban card (button) to avoid hitting a leftover toast.
    await mainWindow.getByRole('button', { name: 'Dialog created task' }).click()
    await expect(mainWindow.locator('[data-testid="terminal-mode-trigger"]:visible').first()).toBeVisible({ timeout: 5_000 })

    // Dismiss "Move to In Progress?" dialog if terminal input triggered it
    const dialog = mainWindow.getByRole('alertdialog')
    if (await dialog.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await dialog.getByRole('button', { name: 'No' }).click()
    }

    // Scope to visible settings panel to avoid hidden tab DOM matches
    const sidebar = mainWindow.locator('[data-testid="task-settings-panel"]:visible')
    const statusTrigger = sidebar.getByText('Status', { exact: true }).locator('..').getByRole('combobox')
    await statusTrigger.click()
    await mainWindow.getByRole('option', { name: 'Review' }).click()
    await expect(statusTrigger).toHaveText('Review', { timeout: 3_000 })

    // Dismiss dialog again if status change triggered it
    if (await dialog.isVisible({ timeout: 500 }).catch(() => false)) {
      await dialog.getByRole('button', { name: 'No' }).click()
    }

    // Verify persisted via API
    const tasks = await seed(mainWindow).getTasks()
    const task = tasks.find((t: { title: string }) => t.title === 'Dialog created task')
    expect(task?.status).toBe('review')
  })

  test('change priority in task detail metadata sidebar', async ({ mainWindow }) => {
    // Dismiss "Move to In Progress?" dialog if it appeared after status change
    const dialog = mainWindow.getByRole('alertdialog')
    if (await dialog.isVisible({ timeout: 500 }).catch(() => false)) {
      await dialog.getByRole('button', { name: 'No' }).click()
    }

    const sidebar = mainWindow.locator('[data-testid="task-settings-panel"]:visible')
    const priorityTrigger = sidebar.getByText('Priority', { exact: true }).locator('..').getByRole('combobox')
    await priorityTrigger.click()
    await mainWindow.getByRole('option', { name: 'Low' }).click()
    await expect(priorityTrigger).toHaveText('Low', { timeout: 3_000 })

    const tasks = await seed(mainWindow).getTasks()
    const task = tasks.find((t: { title: string }) => t.title === 'Dialog created task')
    expect(task?.priority).toBe(4)
  })

  test('go back to kanban after metadata edits', async ({ mainWindow }) => {
    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.locator('h3').getByText('Inbox', { exact: true })).toBeVisible({ timeout: 5_000 })
  })
})
