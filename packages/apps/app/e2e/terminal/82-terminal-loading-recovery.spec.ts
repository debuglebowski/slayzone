import { test, expect, seed, resetApp, goHome, clickProject } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  getMainSessionId,
  openTaskTerminal,
  runCommand,
  waitForBufferContains,
  waitForPtySession,
} from '../fixtures/terminal'

test.describe('Terminal loading recovery', () => {
  let projectAbbrev: string
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Loading Recovery', color: '#ef4444', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()

    const t = await s.createTask({ projectId: p.id, title: 'Loading recovery task', status: 'in_progress' })
    taskId = t.id

    await mainWindow.evaluate((id) => window.api.db.updateTask({ id, terminalMode: 'terminal' }), taskId)
    await s.refreshData()
  })

  test('terminal shows after navigating away and back', async ({ mainWindow }) => {
    const marker = `RECOVER_${Date.now()}`

    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Loading recovery task' })

    const sessionId = getMainSessionId(taskId)
    await waitForPtySession(mainWindow, sessionId)
    await runCommand(mainWindow, sessionId, `echo ${marker}`)
    await waitForBufferContains(mainWindow, sessionId, marker)

    // Navigate away
    await goHome(mainWindow)

    // Navigate back
    await clickProject(mainWindow, projectAbbrev)
    await mainWindow.getByText('Loading recovery task').first().click()

    // Terminal should be visible without stuck loading spinner
    await waitForPtySession(mainWindow, sessionId)
    const xtermVisible = mainWindow.locator('[data-session-id] .xterm:visible').first()
    await expect(xtermVisible).toBeVisible({ timeout: 10_000 })
  })

  test('terminal shows after rapid tab switches', async ({ mainWindow }) => {
    // Create a second task to switch between
    const s = seed(mainWindow)
    const t2 = await s.createTask({ projectId: (await mainWindow.evaluate((id) => window.api.db.getTask(id), taskId))!.project_id, title: 'Switch target task', status: 'todo' })
    await mainWindow.evaluate((id) => window.api.db.updateTask({ id, terminalMode: 'terminal' }), t2.id)
    await s.refreshData()

    // Open first task
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Loading recovery task' })
    const sessionId = getMainSessionId(taskId)
    await waitForPtySession(mainWindow, sessionId)

    // Rapidly switch: task1 → task2 → task1
    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await mainWindow.getByText('Switch target task').first().click()
    await mainWindow.waitForTimeout(200)

    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await mainWindow.getByText('Loading recovery task').first().click()

    // First task's terminal should be visible (not stuck loading)
    await waitForPtySession(mainWindow, sessionId)
    const xtermVisible = mainWindow.locator('[data-session-id] .xterm:visible').first()
    await expect(xtermVisible).toBeVisible({ timeout: 10_000 })
  })
})
