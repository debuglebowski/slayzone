import { test, expect, seed, goHome, clickProject, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'

test.describe('List view: drop into empty status group', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)

    // Create project with default columns (inbox, backlog, todo, in_progress, review, done, canceled)
    const project = await s.createProject({ name: 'List Drop', color: '#8b5cf6', path: TEST_PROJECT_PATH })

    // Seed tasks only in todo — leave review empty
    await s.createTask({ projectId: project.id, title: 'Move me to review', status: 'todo' })
    await s.createTask({ projectId: project.id, title: 'Stay in todo', status: 'todo' })

    await s.refreshData()
    await goHome(mainWindow)
    await clickProject(mainWindow, 'LI')
    await expect(mainWindow.getByText('Move me to review').first()).toBeVisible({ timeout: 5_000 })
  })

  test('can drop task into empty status group', async ({ mainWindow }) => {
    // Switch to list view
    await mainWindow.getByRole('button', { name: /Display/ }).first().click()
    await mainWindow.getByRole('button', { name: 'List' }).click()

    // Ensure grouped by status (default)
    // Enable show empty groups so the Review group is visible
    const emptySwitch = mainWindow.locator('#display-empty-cols')
    const isChecked = await emptySwitch.isChecked()
    if (!isChecked) await emptySwitch.click()

    // Close display popover by pressing Escape
    await mainWindow.keyboard.press('Escape')

    // Verify Review group header visible (empty group)
    const reviewHeader = mainWindow.getByText('Review', { exact: true })
    await expect(reviewHeader).toBeVisible({ timeout: 3_000 })

    const reviewHeaderRow = reviewHeader.locator('xpath=ancestor::div[contains(@class,"bg-muted/50")][1]')
    const reviewDropZone = reviewHeaderRow.locator('xpath=following-sibling::div[1]')

    // Verify the task count badge shows 0 for Review
    await expect(reviewHeaderRow.getByText('0')).toBeVisible()

    // The empty-column droppable is the placeholder below the header, not the header itself.
    const dropHint = reviewDropZone.getByText('Drop here')
    await expect(dropHint).toBeAttached()

    const s = seed(mainWindow)
    const tasks = await s.getTasks()
    const movedTask = tasks.find((t: { title: string }) => t.title === 'Move me to review')

    expect(movedTask?.id).toBeTruthy()

    await mainWindow.evaluate(({ taskId }) => {
      const moveTask = (window as { __slayzone_moveTaskForTest?: (taskId: string, newColumnId: string, targetIndex: number) => void }).__slayzone_moveTaskForTest
      if (!moveTask) throw new Error('Missing __slayzone_moveTaskForTest hook')
      moveTask(taskId, 'review', 0)
    }, { taskId: movedTask!.id })

    await expect.poll(async () => {
      const nextTasks = await s.getTasks()
      return nextTasks.find((t: { id: string }) => t.id === movedTask!.id)?.status
    }, { timeout: 5_000 }).toBe('review')

    await expect(reviewHeaderRow.getByText('1')).toBeVisible({ timeout: 3_000 })
  })
})
