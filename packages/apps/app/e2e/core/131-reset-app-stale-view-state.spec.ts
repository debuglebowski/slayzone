import {
  test,
  expect,
  seed,
  goHome,
  clickProject,
  resetApp,
  openTaskById,
  TEST_PROJECT_PATH
} from '../fixtures/electron'

// Regression: `useTabStore` persists `viewState` on a 500ms debounce. A spec that
// changed tabs just before the next spec's `resetApp` left that write pending in the
// OLD renderer; it landed after the DB wipe, so the reload restored the deleted task
// as the ACTIVE tab ("Task not found") and the next spec's board stayed hidden.
// Observed in the full suite as 11-create-task-dialog's beforeAll timing out on Inbox.
test.describe('resetApp vs pending viewState write', () => {
  test('a tab change right before resetApp does not survive the reset', async ({
    mainWindow
  }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const old = await s.createProject({ name: 'Stale Tab', color: '#ef4444', path: TEST_PROJECT_PATH })
    const task = await s.createTask({ projectId: old.id, title: 'Doomed task', status: 'todo' })
    await s.refreshData()
    await openTaskById(mainWindow, task.id)

    // Tab change → debounced write pending → reset while it is still in flight.
    await resetApp(mainWindow)

    await expect(mainWindow.getByText('Task not found')).toHaveCount(0)

    const p = await seed(mainWindow).createProject({
      name: 'Fresh Board',
      color: '#3b82f6',
      path: TEST_PROJECT_PATH
    })
    await seed(mainWindow).refreshData()
    await goHome(mainWindow)
    await clickProject(mainWindow, p.name.slice(0, 2).toUpperCase())
    await expect(mainWindow.locator('h3').getByText('Inbox', { exact: true })).toBeVisible({
      timeout: 5_000
    })
  })
})
