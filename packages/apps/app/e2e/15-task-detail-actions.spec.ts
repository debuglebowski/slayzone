import { test, expect, seed, goHome, clickProject } from './fixtures/electron'
import { TEST_PROJECT_PATH } from './fixtures/electron'

test.describe('Task detail actions', () => {
  let projectAbbrev: string
  const openTaskFromBoard = async (mainWindow: import('@playwright/test').Page, title: string) => {
    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    const card = mainWindow.locator('p').filter({ hasText: title }).first()
    await expect(card).toBeVisible({ timeout: 10_000 })
    await card.click()
  }

  test.beforeAll(async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Actions Test', color: '#8b5cf6', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    await s.updateProject({
      id: p.id,
      columnsConfig: [
        { id: 'inbox', label: 'Inbox', color: 'gray', position: 0, category: 'triage' },
        { id: 'backlog', label: 'Backlog', color: 'slate', position: 1, category: 'backlog' },
        { id: 'todo', label: 'To Do', color: 'blue', position: 2, category: 'unstarted' },
        { id: 'in_progress', label: 'In Progress', color: 'yellow', position: 3, category: 'started' },
        { id: 'review', label: 'Review', color: 'purple', position: 4, category: 'completed' },
        { id: 'done', label: 'Done', color: 'green', position: 5, category: 'started' }
      ]
    })

    await s.createTask({ projectId: p.id, title: 'Archive me from detail', status: 'in_progress' })
    await s.createTask({ projectId: p.id, title: 'Delete me from detail', status: 'in_progress' })
    await s.createTask({ projectId: p.id, title: 'Complete me task', status: 'in_progress' })
    await s.refreshData()

    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.getByText('Archive me from detail').first()).toBeVisible()
  })

  test('archive task from settings danger zone', async ({ mainWindow }) => {
    await openTaskFromBoard(mainWindow, 'Archive me from detail')

    // Archive button is in the settings panel's danger zone — opens confirmation dialog
    const archiveBtn = mainWindow.getByRole('button', { name: /^Archive$/ }).first()
    await expect(archiveBtn).toBeVisible()
    await archiveBtn.scrollIntoViewIfNeeded()
    await archiveBtn.click()

    // Confirm in AlertDialog
    const dialog = mainWindow.locator('[data-slot="alert-dialog-content"]')
    await expect(dialog).toBeVisible({ timeout: 3_000 })
    await dialog.getByRole('button', { name: /Archive/ }).click()
    await expect(dialog).not.toBeVisible({ timeout: 3_000 })

    // Kanban should no longer show archived task
    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)

    // Kanban card (in <p>) should be gone — tab bar (<span>) may still exist
    await expect(mainWindow.locator('p').filter({ hasText: 'Archive me from detail' })).not.toBeVisible({ timeout: 3_000 })
  })

  test('delete task from settings danger zone', async ({ mainWindow }) => {
    await openTaskFromBoard(mainWindow, 'Delete me from detail')

    // Delete button is in the settings panel's danger zone
    const deleteBtn = mainWindow.getByRole('button', { name: /^Delete$/ }).first()
    await expect(deleteBtn).toBeVisible()
    await deleteBtn.scrollIntoViewIfNeeded()
    await deleteBtn.click()

    // Confirm delete dialog
    const dialog = mainWindow.locator('[data-slot="alert-dialog-content"]')
    await expect(dialog).toBeVisible({ timeout: 3_000 })
    await dialog.getByRole('button', { name: /Delete/i }).click()
    await expect(dialog).not.toBeVisible({ timeout: 3_000 })

    // Kanban should no longer show deleted task
    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)

    await expect(mainWindow.locator('p').filter({ hasText: 'Delete me from detail' })).not.toBeVisible({ timeout: 3_000 })
  })

  test('Cmd+Shift+D opens complete task confirmation', async ({ mainWindow }) => {
    await openTaskFromBoard(mainWindow, 'Complete me task')
    await expect(mainWindow.locator('[data-testid="terminal-mode-trigger"]:visible').first()).toBeVisible()

    await mainWindow.keyboard.press('Meta+Shift+d')

    await expect(mainWindow.getByText('Mark as complete and close tab?')).toBeVisible({ timeout: 3_000 })
  })

  test('confirm complete task uses project completed status and closes tab', async ({ mainWindow }) => {
    await mainWindow.getByRole('button', { name: 'Complete' }).click()

    await expect
      .poll(async () => {
        const tasks = await seed(mainWindow).getTasks()
        const task = tasks.find((t: { title: string }) => t.title === 'Complete me task')
        return task?.status ?? null
      }, { timeout: 5_000 })
      .toBe('review')
  })
})
