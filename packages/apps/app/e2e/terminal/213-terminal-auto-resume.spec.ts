import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  getMainSessionId,
  openTaskTerminal,
  waitForBufferContains,
  readFullBuffer
} from '../fixtures/terminal'

// An agent that dies MID-SESSION without SlayZone asking (2026-11-14: the hub's
// stray sweep SIGHUP'd live agents, exit 129) is resumed on its conversation in the
// same terminal — not replaced by a recovery shell (that stays for start failures,
// 55-terminal-shell-fallback). The custom agent prints, lives past the 10 s startup
// window, then exits 129; its resume command prints the conversation id it got.
test.describe('Terminal auto-resume after an unexpected agent exit', () => {
  const customModeId = 'auto-resume-e2e'
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
      window
        .getTrpcVanillaClient()
        .settings.set.mutate({ key: 'terminal_agent_startup', value: 'instant' })
    )
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Auto Resume',
      color: '#dc2626',
      path: TEST_PROJECT_PATH
    })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()

    // `{id}` makes SlayZone mint the conversation id up front, as for claude-code.
    await mainWindow.evaluate((id) => {
      return window.getTrpcVanillaClient().pty.agentsCreate.mutate({
        id,
        label: 'Dying CLI',
        type: 'custom',
        initialCommand: "sh -c 'echo started-{id}; sleep 12; exit 129'",
        resumeCommand: "sh -c 'echo resumed-{id}; sleep 600'",
        defaultFlags: '',
        enabled: true
      })
    }, customModeId)

    const t = await s.createTask({
      projectId: p.id,
      title: 'Auto resume task',
      status: 'in_progress'
    })
    taskId = t.id

    await mainWindow.evaluate(
      ({ id, mode }) => window.getTrpcVanillaClient().task.update.mutate({ id, agentId: mode }),
      { id: taskId, mode: customModeId }
    )
    await s.refreshData()
  })

  test.afterAll(async ({ mainWindow }) => {
    if (customModeId) {
      await mainWindow
        .evaluate(
          (id) => window.getTrpcVanillaClient().pty.agentsDelete.mutate({ id }),
          customModeId
        )
        .catch(() => {})
    }
    await mainWindow
      .evaluate(() =>
        window
          .getTrpcVanillaClient()
          .settings.set.mutate({ key: 'terminal_agent_startup', value: 'manual' })
      )
      .catch(() => {})
  })

  test('resumes the same conversation in place, with an info line', async ({ mainWindow }) => {
    // The agent must outlive the 10 s startup window before it dies.
    test.setTimeout(90_000)
    const sessionId = getMainSessionId(taskId)
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Auto resume task' })

    await waitForBufferContains(mainWindow, sessionId, 'started-', 30_000)
    // 12 s alive, exit 129, then the resume.
    await waitForBufferContains(mainWindow, sessionId, 'resumed-', 60_000)

    const buffer = await readFullBuffer(mainWindow, sessionId)
    expect(buffer).toContain('exited unexpectedly (code 129)')
    expect(buffer).toContain('resuming conversation')
    expect(buffer).not.toContain('interactive shell for recovery')
    const started = buffer.match(/started-([0-9a-f-]{36})/)?.[1]
    const resumed = buffer.match(/resumed-([0-9a-f-]{36})/)?.[1]
    expect(started).toBeTruthy()
    expect(resumed).toBe(started)
  })
})
