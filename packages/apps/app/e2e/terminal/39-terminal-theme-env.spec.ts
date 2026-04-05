import { test, expect, seed, resetApp} from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  openTaskTerminal,
  switchTerminalMode,
  getMainSessionId,
  waitForPtySession,
  runCommand,
  waitForBufferContains,
  readFullBuffer
} from '../fixtures/terminal'

test.describe('Terminal theme environment variables', () => {
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Theme Env', color: '#06b6d4', path: TEST_PROJECT_PATH })
    const t = await s.createTask({ projectId: p.id, title: 'Theme env task', status: 'in_progress' })
    taskId = t.id
    await s.refreshData()

    await openTaskTerminal(mainWindow, { projectAbbrev: 'TH', taskTitle: 'Theme env task' })
    await switchTerminalMode(mainWindow, 'terminal')
  })

  test('COLORFGBG is set in PTY environment', async ({ mainWindow }) => {
    const sessionId = getMainSessionId(taskId)
    await waitForPtySession(mainWindow, sessionId)

    // Use a unique marker so we match the output, not the typed command
    await runCommand(mainWindow, sessionId, 'echo "CFG:$COLORFGBG"')
    // Wait for either light or dark value
    await expect.poll(async () => {
      const buf = await readFullBuffer(mainWindow, sessionId)
      return buf.includes('CFG:0;15') || buf.includes('CFG:15;0')
    }, { timeout: 10_000 }).toBe(true)
  })

  test('TERM_BACKGROUND is set in PTY environment', async ({ mainWindow }) => {
    const sessionId = getMainSessionId(taskId)

    await runCommand(mainWindow, sessionId, 'echo "TBG:$TERM_BACKGROUND"')
    await expect.poll(async () => {
      const buf = await readFullBuffer(mainWindow, sessionId)
      return buf.includes('TBG:light') || buf.includes('TBG:dark')
    }, { timeout: 10_000 }).toBe(true)
  })

  test('COLORTERM is truecolor', async ({ mainWindow }) => {
    const sessionId = getMainSessionId(taskId)

    await runCommand(mainWindow, sessionId, 'echo "CT:$COLORTERM"')
    await waitForBufferContains(mainWindow, sessionId, 'CT:truecolor')
  })
})
