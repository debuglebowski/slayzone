import type { Page } from '@playwright/test'
import { test, expect, seed, openTaskById, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'

// Regression: the task header's status menu sent snake_case update keys
// (`is_blocked`, `snoozed_until`) straight to `task.update`, which reads only
// camelCase — so Blocked / Snooze from that menu never saved.
test.describe('Task header status menu', () => {
  const getTask = (page: Page, id: string) =>
    page.evaluate((i) => window.getTrpcVanillaClient().task.get.query({ id: i }), id)

  test('Blocked saves the task as blocked', async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Status Menu',
      color: '#f97316',
      path: TEST_PROJECT_PATH
    })
    const t = await s.createTask({ projectId: p.id, title: 'SM task', status: 'todo' })
    await s.refreshData()

    await openTaskById(mainWindow, t.id)
    await mainWindow.locator('[data-testid="task-status-menu-trigger"]:visible').click()
    await mainWindow.getByRole('menuitem', { name: 'Blocked', exact: true }).click()
    await expect.poll(async () => (await getTask(mainWindow, t.id))?.is_blocked).toBe(true)
  })
})
