import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  getMainSessionId,
  openTaskTerminal,
  waitForPtySession,
  waitForBufferContains,
  readFullBuffer
} from '../fixtures/terminal'

test.describe('Terminal shell fallback on CLI crash', () => {
  const customModeId = 'shell-fallback-e2e'
  let projectAbbrev: string
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    // AI-mode terminals are idle-gated (TerminalStarter). startAgentTerminal's
    // starter-button regex only knows built-in agent labels, so a custom mode
    // ("Open Failing CLI") would never get clicked — seed auto-start instead so
    // the terminal mounts (and the failing CLI spawns) without the gate. The
    // gate itself is 93/97's subject, not this spec's.
    await mainWindow.evaluate(() =>
      window.getTrpcVanillaClient().settings.set.mutate({ key: 'terminal_auto_start', value: '1' })
    )
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Shell Fallback',
      color: '#dc2626',
      path: TEST_PROJECT_PATH
    })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()

    // Create a custom terminal mode whose command always exits with code 1
    await mainWindow.evaluate((id) => {
      return window.getTrpcVanillaClient().pty.modesCreate.mutate({
        id,
        label: 'Failing CLI',
        type: 'custom',
        initialCommand: 'false',
        resumeCommand: '',
        defaultFlags: '',
        enabled: true
      })
    }, customModeId)

    const t = await s.createTask({
      projectId: p.id,
      title: 'Crash recovery task',
      status: 'in_progress'
    })
    taskId = t.id

    await mainWindow.evaluate(
      ({ id, mode }) => window.getTrpcVanillaClient().task.update.mutate({ id, terminalMode: mode }),
      { id: taskId, mode: customModeId }
    )
    await s.refreshData()
  })

  test.afterAll(async ({ mainWindow }) => {
    if (customModeId) {
      await mainWindow
        .evaluate((id) => window.getTrpcVanillaClient().pty.modesDelete.mutate({ id }), customModeId)
        .catch(() => {})
    }
    await mainWindow
      .evaluate(() =>
        window.getTrpcVanillaClient().settings.set.mutate({ key: 'terminal_auto_start', value: '0' })
      )
      .catch(() => {})
  })

  test('spawns interactive shell after CLI exits non-zero', async ({ mainWindow }) => {
    const sessionId = getMainSessionId(taskId)

    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Crash recovery task' })

    // Skip waitForPtySession — initialCommand 'false' may exit before the
    // check observes the session. Wait for the fallback's recovery banner
    // in the buffer directly; the shell-fallback feature spawns a new PTY
    // and writes the [SlayZone] message after the original exits.
    await waitForBufferContains(mainWindow, sessionId, '[SlayZone]', 15_000)

    const buffer = await readFullBuffer(mainWindow, sessionId)
    expect(buffer).toContain('exited with code')
    expect(buffer).toContain('interactive shell for recovery')
  })
})
