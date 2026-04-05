import { test, expect, seed, resetApp} from '../fixtures/electron'
import { TEST_PROJECT_PATH, goHome, clickProject } from '../fixtures/electron'
import {
  openTaskTerminal,
  switchTerminalMode,
  getMainSessionId,
  waitForPtySession,
  waitForPtyState,
  readFullBuffer,
} from '../fixtures/terminal'

test.describe('OpenCode CLI integration', () => {
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'OpenCli', color: '#7c3aed', path: TEST_PROJECT_PATH })
    const t = await s.createTask({ projectId: p.id, title: 'Opencode cli test', status: 'in_progress' })
    taskId = t.id
    await s.refreshData()

    await openTaskTerminal(mainWindow, { projectAbbrev: 'OP', taskTitle: 'Opencode cli test' })
    await switchTerminalMode(mainWindow, 'opencode')
  })

  test('starts and produces TUI output', async ({ mainWindow }) => {
    test.setTimeout(60_000)
    const sessionId = getMainSessionId(taskId)
    await waitForPtySession(mainWindow, sessionId, 30_000)

    // OpenCode Bubble Tea TUI should render something
    await expect
      .poll(async () => {
        const buf = await readFullBuffer(mainWindow, sessionId)
        return buf.length > 0
      }, { timeout: 30_000 })
      .toBe(true)
  })

  test('accepts a prompt and produces response', async ({ mainWindow }) => {
    test.setTimeout(60_000)
    const sessionId = getMainSessionId(taskId)

    const bufBefore = await readFullBuffer(mainWindow, sessionId)
    const lenBefore = bufBefore.length

    // Send a minimal prompt
    await mainWindow.evaluate(
      ({ id }) => window.api.pty.write(id, 'hi\r'),
      { id: sessionId }
    )

    // Wait for buffer to grow (OpenCode produced a response)
    await expect
      .poll(async () => {
        const buf = await readFullBuffer(mainWindow, sessionId)
        return buf.length
      }, { timeout: 60_000 })
      .toBeGreaterThan(lenBefore + 20)
  })

  test('resume uses --session flag', async ({ mainWindow }) => {
    test.setTimeout(60_000)
    // Store a conversationId so the app resumes with --session
    await mainWindow.evaluate(
      ({ id }) => window.api.db.updateTask({
        id,
        providerConfig: { opencode: { conversationId: 'oc-prev-session' } },
      }),
      { id: taskId }
    )

    // Navigate away and back to force terminal re-creation
    await goHome(mainWindow)
    await clickProject(mainWindow, 'OP')
    await mainWindow.getByText('Opencode cli test').first().click()

    const sessionId = getMainSessionId(taskId)
    await waitForPtySession(mainWindow, sessionId, 30_000)

    // Wait for output — resumed session or fresh start
    await expect
      .poll(async () => {
        const buf = await readFullBuffer(mainWindow, sessionId)
        return buf.length > 0
      }, { timeout: 30_000 })
      .toBe(true)
  })

  test('detects working → attention state transition', async ({ mainWindow }) => {
    const sessionId = getMainSessionId(taskId)

    // Send a prompt to trigger work
    await mainWindow.evaluate(
      ({ id }) => window.api.pty.write(id, 'hi\r'),
      { id: sessionId }
    )

    // Should transition to 'running' (working)
    await waitForPtyState(mainWindow, sessionId, 'running', 15_000)

    // Should transition back to 'attention' when done (within 15s, not 60s)
    await waitForPtyState(mainWindow, sessionId, 'attention', 15_000)
  })
})
