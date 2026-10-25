import type { Page } from '@playwright/test'
import { test, expect, seed, openTaskById, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import { pressShortcut } from '../fixtures/shortcuts'

// Cmd+K inside a task shows a "Current task" section with the task's own commands;
// value commands (status, priority…) open a sub-page, and their values are also
// reachable straight from search ("done" → "Status → Done").
test.describe('Cmd+K task commands', () => {
  const getTask = (page: Page, id: string) =>
    page.evaluate((i) => window.getTrpcVanillaClient().task.get.query({ id: i }), id)
  const palette = (page: Page) => page.locator('[cmdk-root]')
  const item = (page: Page, text: string) =>
    palette(page).locator('[cmdk-item]').filter({ hasText: text })

  let taskA: string
  let taskB: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Cmdk Task',
      color: '#22c55e',
      path: TEST_PROJECT_PATH
    })
    taskA = (await s.createTask({ projectId: p.id, title: 'CK task A', status: 'todo' })).id
    taskB = (await s.createTask({ projectId: p.id, title: 'CK task B', status: 'todo' })).id
    await s.refreshData()
  })

  test('the section belongs to the active tab only', async ({ mainWindow }) => {
    await openTaskById(mainWindow, taskA)
    await openTaskById(mainWindow, taskB)
    await pressShortcut(mainWindow, 'search')
    await expect(palette(mainWindow).getByText('Current task · CK task B')).toBeVisible({
      timeout: 5_000
    })
    await expect(palette(mainWindow).getByText('Current task · CK task A')).toHaveCount(0)
    await mainWindow.keyboard.press('Escape')
  })

  test('status sub-page sets the status; Backspace goes back', async ({ mainWindow }) => {
    await openTaskById(mainWindow, taskA)
    await pressShortcut(mainWindow, 'search')
    await item(mainWindow, 'Change status…').click()
    await expect(mainWindow.getByPlaceholder('Search status...')).toBeVisible()

    // Backspace on the empty input pops back to the root list.
    await mainWindow.keyboard.press('Backspace')
    await expect(item(mainWindow, 'Change priority…')).toBeVisible()

    await item(mainWindow, 'Change status…').click()
    await item(mainWindow, 'In Progress').click()
    await expect(palette(mainWindow)).toHaveCount(0)
    await expect.poll(async () => (await getTask(mainWindow, taskA))?.status).toBe('in_progress')
  })

  test('a sub-page value is reachable straight from search', async ({ mainWindow }) => {
    await openTaskById(mainWindow, taskB)
    await pressShortcut(mainWindow, 'search')
    await mainWindow.keyboard.type('status review')
    await expect(item(mainWindow, 'Status → Review')).toBeVisible()
    await mainWindow.keyboard.press('Enter')
    await expect.poll(async () => (await getTask(mainWindow, taskB))?.status).toBe('review')
  })

  test('rename focuses the header title, selected', async ({ mainWindow }) => {
    await openTaskById(mainWindow, taskB)
    await pressShortcut(mainWindow, 'search')
    await mainWindow.keyboard.type('rename task')
    await expect(item(mainWindow, 'Rename task')).toBeVisible()
    await mainWindow.keyboard.press('Enter')
    await expect(palette(mainWindow)).toHaveCount(0)
    // Focus must survive the dialog's close (its focus trap restores on unmount).
    await expect
      .poll(() =>
        mainWindow.evaluate(() => {
          const el = document.activeElement as HTMLInputElement | null
          return el?.tagName === 'INPUT' && !el.readOnly
            ? el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0)
            : null
        })
      )
      .toBe('CK task B')
  })

  test('new subtask prompt creates a subtask', async ({ mainWindow }) => {
    await openTaskById(mainWindow, taskA)
    await pressShortcut(mainWindow, 'search')
    await item(mainWindow, 'New subtask…').click()
    await mainWindow.keyboard.type('CK sub one')
    await mainWindow.keyboard.press('Enter')
    await expect
      .poll(async () =>
        (
          await mainWindow.evaluate(
            (id) => window.getTrpcVanillaClient().task.getSubTasks.query({ parentId: id }),
            taskA
          )
        ).map((t) => t.title)
      )
      .toEqual(['CK sub one'])
  })
})
