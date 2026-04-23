import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import { openTaskTerminal } from '../fixtures/terminal'

test.describe('Manager mode persistence', () => {
  let projectAbbrev: string
  let parentTaskId: string
  let parentTitle: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)

    const p = await s.createProject({ name: 'Manager Mode', color: '#8b5cf6', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()

    parentTitle = 'Parent for manager mode'
    const parent = await s.createTask({ projectId: p.id, title: parentTitle, status: 'in_progress' })
    parentTaskId = parent.id

    // Subtask — toggle button only renders when direct children exist.
    await mainWindow.evaluate(
      ({ projectId, parentId }) => window.api.db.createTask({ projectId, title: 'Subtask A', status: 'in_progress', parentId }),
      { projectId: p.id, parentId: parentTaskId }
    )

    // Use raw shell to avoid any AI CLI boot in tests.
    await mainWindow.evaluate((id) => window.api.db.updateTask({ id, terminalMode: 'terminal' }), parentTaskId)
    await s.refreshData()
  })

  test('updateTask({managerMode}) writes tasks.manager_mode column', async ({ mainWindow }) => {
    await mainWindow.evaluate((id) => window.api.db.updateTask({ id, managerMode: true }), parentTaskId)
    let task = await mainWindow.evaluate((id) => window.api.db.getTask(id), parentTaskId)
    expect(task?.manager_mode).toBe(true)

    await mainWindow.evaluate((id) => window.api.db.updateTask({ id, managerMode: false }), parentTaskId)
    task = await mainWindow.evaluate((id) => window.api.db.getTask(id), parentTaskId)
    expect(task?.manager_mode).toBe(false)
  })

  test('toggle persists across task-tab close/reopen', async ({ mainWindow }) => {
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: parentTitle })

    // Toggle on.
    const toggle = mainWindow.locator('[data-testid="terminal-manager-toggle"]:visible').first()
    await expect(toggle).toBeVisible()
    await toggle.click()
    await expect(mainWindow.locator('[data-testid="manager-sidebar"]:visible').first()).toBeVisible()

    // DB reflects the toggle.
    await expect
      .poll(async () => {
        const t = await mainWindow.evaluate((id) => window.api.db.getTask(id), parentTaskId)
        return t?.manager_mode
      }, { timeout: 2_000 })
      .toBe(true)

    // Reload window → fresh TerminalContainer mount must restore sidebar from persisted task.manager_mode.
    await mainWindow.reload()
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: parentTitle })
    await expect(mainWindow.locator('[data-testid="manager-sidebar"]:visible').first()).toBeVisible()
  })
})
