import { test, expect, seed, resetApp, openTaskById, TEST_PROJECT_PATH } from '../fixtures/electron'

// The task tab's Project field moves a task the same way the board menus do: the
// pick opens the move dialog, nothing moves until it is confirmed, and then the
// open tab shows the new project (it re-reads the moved task).
test.describe('Move a task from its Project field', () => {
  test('pick → dialog → confirm moves the task and the tab follows', async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const from = await s.createProject({
      name: 'Field From',
      color: '#2563eb',
      path: TEST_PROJECT_PATH
    })
    const to = await s.createProject({
      name: 'Field To',
      color: '#16a34a',
      path: TEST_PROJECT_PATH
    })
    const task = await s.createTask({ projectId: from.id, title: 'Field mover', status: 'todo' })
    await s.refreshData()
    await openTaskById(mainWindow, task.id)

    const field = mainWindow.getByTestId('task-project-field').filter({ visible: true })
    await expect(field.getByRole('combobox')).toContainText('Field From', { timeout: 10_000 })
    await field.getByRole('combobox').click()
    await mainWindow.getByRole('option', { name: 'Field To' }).click()

    const dialog = mainWindow.getByTestId('move-task-dialog')
    await expect(dialog).toBeVisible({ timeout: 5_000 })
    // Nothing moves before the confirm.
    const before = (await s.getTasks()).find((t: { id: string }) => t.id === task.id)
    expect(before?.project_id).toBe(from.id)
    const confirm = dialog.getByTestId('move-task-confirm')
    await expect(confirm).toBeEnabled({ timeout: 5_000 })
    await confirm.click()
    await expect(dialog).toBeHidden({ timeout: 5_000 })

    await expect
      .poll(
        async () => (await s.getTasks()).find((t: { id: string }) => t.id === task.id)?.project_id,
        { timeout: 5_000 }
      )
      .toBe(to.id)
    await expect(field.getByRole('combobox')).toContainText('Field To', { timeout: 5_000 })
  })
})
