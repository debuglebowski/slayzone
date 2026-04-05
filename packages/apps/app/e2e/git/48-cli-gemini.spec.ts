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

// Skip: Gemini CLI boot time exceeds test timeouts under parallel load.
// The real binary takes too long to produce output when competing with multiple
// Electron instances for CPU. Not an app bug — CLI startup is inherently slow.
test.describe.skip('Gemini integration', () => {
  let projectAbbrev: string
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'GeminiCli', color: '#059669', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    const t = await s.createTask({ projectId: p.id, title: 'Gemini cli test', status: 'in_progress' })
    taskId = t.id
    await s.refreshData()

    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Gemini cli test' })
    await switchTerminalMode(mainWindow, 'gemini')
  })

  test('starts and produces output', async ({ mainWindow }) => {
    test.setTimeout(60_000)
    const sessionId = getMainSessionId(taskId)
    await waitForPtySession(mainWindow, sessionId, 30_000)

    // Gemini TUI should render something
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

    // Capture buffer size before prompt
    const bufBefore = await readFullBuffer(mainWindow, sessionId)
    const lenBefore = bufBefore.length

    // Send a minimal prompt
    await mainWindow.evaluate(
      ({ id }) => window.api.pty.write(id, 'hi\r'),
      { id: sessionId }
    )

    // Wait for buffer to grow (Gemini produced a response)
    await expect
      .poll(async () => {
        const buf = await readFullBuffer(mainWindow, sessionId)
        return buf.length
      }, { timeout: 60_000 })
      .toBeGreaterThan(lenBefore + 20)
  })

  test('resume uses --resume latest', async ({ mainWindow }) => {
    test.setTimeout(60_000)
    // Store a marker conversationId so the app thinks there's a previous session
    await mainWindow.evaluate(
      ({ id }) => window.api.db.updateTask({
        id,
        providerConfig: { gemini: { conversationId: 'gemini-previous' } },
      }),
      { id: taskId }
    )

    // Navigate away and back to force terminal re-creation
    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await mainWindow.getByText('Gemini cli test').first().click()

    const sessionId = getMainSessionId(taskId)
    await waitForPtySession(mainWindow, sessionId, 30_000)

    // Wait for output — if resume works, Gemini should load previous session
    await expect
      .poll(async () => {
        const buf = await readFullBuffer(mainWindow, sessionId)
        return buf.length > 0
      }, { timeout: 30_000 })
      .toBe(true)

    // Verify the buffer shows some content (resumed session or at least no error)
    const buf = await readFullBuffer(mainWindow, sessionId)
    // If gemini errored on resume, the buffer would contain an error message
    expect(buf).not.toContain('GEMINI_API_KEY environment variable not found')
  })

  test('detects working → attention state transition', async ({ mainWindow }) => {
    const sessionId = getMainSessionId(taskId)

    // Wait for session to be ready
    await waitForPtySession(mainWindow, sessionId, 30_000)
    await expect
      .poll(async () => (await readFullBuffer(mainWindow, sessionId)).length > 50, { timeout: 15_000 })
      .toBe(true)

    // Send a prompt to trigger work
    await mainWindow.evaluate(
      ({ id }) => window.api.pty.write(id, 'say ok\r'),
      { id: sessionId }
    )

    // Should transition to 'running' (working detected from TUI redraw burst)
    await waitForPtyState(mainWindow, sessionId, 'running', 15_000)

    // Should transition back to 'attention' after idle timeout (~2.5s)
    await waitForPtyState(mainWindow, sessionId, 'attention', 15_000)
  })
})
