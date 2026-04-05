import { test, expect, seed, resetApp} from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  openTaskTerminal,
  switchTerminalMode,
  getMainSessionId,
  waitForPtySession,
  waitForPtyState,
  waitForBufferContains,
  readFullBuffer,
} from '../fixtures/terminal'

// Skip: Cursor Agent CLI boot time exceeds test timeouts under parallel load.
// The real binary takes too long to produce output when competing with multiple
// Electron instances for CPU. Not an app bug — CLI startup is inherently slow.
test.describe.skip('Cursor Agent CLI integration', () => {
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'CursorCli', color: '#e11d48', path: TEST_PROJECT_PATH })
    const t = await s.createTask({ projectId: p.id, title: 'Cursor agent test', status: 'in_progress' })
    taskId = t.id
    await s.refreshData()

    await openTaskTerminal(mainWindow, { projectAbbrev: 'CU', taskTitle: 'Cursor agent test' })
    await switchTerminalMode(mainWindow, 'cursor-agent')
  })

  test('starts and produces output', async ({ mainWindow }) => {
    test.setTimeout(60_000)
    const sessionId = getMainSessionId(taskId)
    await waitForPtySession(mainWindow, sessionId, 30_000)

    // Wait for any output — cursor-agent TUI should render something
    await expect
      .poll(async () => {
        const buf = await readFullBuffer(mainWindow, sessionId)
        return buf.length > 0
      }, { timeout: 30_000 })
      .toBe(true)
  })

  test('accepts a prompt and produces response', async ({ mainWindow }) => {
    const sessionId = getMainSessionId(taskId)

    // Send a simple prompt
    await mainWindow.evaluate(
      ({ id }) => window.api.pty.write(id, 'say the word hello\r'),
      { id: sessionId }
    )

    await waitForBufferContains(mainWindow, sessionId, 'hello', 60_000)
  })

  test('detects working → attention state transition', async ({ mainWindow }) => {
    const sessionId = getMainSessionId(taskId)

    // Send a prompt to trigger work
    await mainWindow.evaluate(
      ({ id }) => window.api.pty.write(id, 'say ok\r'),
      { id: sessionId }
    )

    // Should transition to 'running' (working)
    await waitForPtyState(mainWindow, sessionId, 'running', 15_000)

    // Should transition back to 'attention' when done
    // Idle checker runs every 10s, timeout is 2.5s → worst case ~12.5s
    await waitForPtyState(mainWindow, sessionId, 'attention', 25_000)
  })
})
