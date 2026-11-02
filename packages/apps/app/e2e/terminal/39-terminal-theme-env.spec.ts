import { test, expect, seed, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  openTaskTerminal,
  getMainSessionId,
  waitForPtySession,
  waitForBufferContains,
  runCommand,
  readFullBuffer
} from '../fixtures/terminal'

test.describe('Terminal theme environment variables', () => {
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Theme Env',
      color: '#06b6d4',
      path: TEST_PROJECT_PATH
    })
    const t = await s.createTask({
      projectId: p.id,
      title: 'Theme env task',
      status: 'in_progress',
      terminalMode: 'terminal'
    })
    taskId = t.id
    await s.refreshData()

    await openTaskTerminal(mainWindow, { projectAbbrev: 'TH', taskTitle: 'Theme env task' })
    const sessionId = getMainSessionId(taskId)
    await waitForPtySession(mainWindow, sessionId)
    await runCommand(mainWindow, sessionId, `printf '__THEME_%s__\\n' 'ENV_READY'`)
    await waitForBufferContains(mainWindow, sessionId, '__THEME_ENV_READY__')
  })

  test('COLORFGBG is set in PTY environment', async ({ mainWindow }) => {
    const sessionId = getMainSessionId(taskId)
    await waitForPtySession(mainWindow, sessionId)

    // Use a unique marker so we match the output, not the typed command
    await runCommand(mainWindow, sessionId, 'echo "CFG:$COLORFGBG"')
    // Wait for either light or dark value
    await expect
      .poll(
        async () => {
          const buf = await readFullBuffer(mainWindow, sessionId)
          return buf.match(/CFG:[^\r\n]*/g) ?? []
        },
        { timeout: 10_000 }
      )
      .toEqual(expect.arrayContaining([expect.stringMatching(/^CFG:(0;15|15;0)$/)]))
  })

  test('TERM_BACKGROUND is set in PTY environment', async ({ mainWindow }) => {
    const sessionId = getMainSessionId(taskId)

    await runCommand(mainWindow, sessionId, 'echo "TBG:$TERM_BACKGROUND"')
    await expect
      .poll(
        async () => {
          const buf = await readFullBuffer(mainWindow, sessionId)
          return buf.match(/TBG:[^\r\n]*/g) ?? []
        },
        { timeout: 10_000 }
      )
      .toEqual(expect.arrayContaining([expect.stringMatching(/^TBG:(light|dark)$/)]))
  })

  test('COLORTERM is truecolor', async ({ mainWindow }) => {
    const sessionId = getMainSessionId(taskId)

    await runCommand(mainWindow, sessionId, 'echo "CT:$COLORTERM"')
    await expect
      .poll(async () => (await readFullBuffer(mainWindow, sessionId)).match(/CT:[^\r\n]*/g) ?? [])
      .toContain('CT:truecolor')
  })
})
