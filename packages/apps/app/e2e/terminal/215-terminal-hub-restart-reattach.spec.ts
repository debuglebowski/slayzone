import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  closeAllTaskTabs,
  getMainSessionId,
  openTaskTerminal,
  readFullBuffer,
  waitForBufferContains,
  waitForPtySession
} from '../fixtures/terminal'

// A hub restart is invisible to a terminal agent. Only the hub restarts (Settings →
// Restart local hub, a crashed sidecar): the computer and its ptys keep running. The
// restarted hub used to leave the agent unseen and unreachable — and the next start
// of its tab made the computer REPLACE it (SIGHUP mid-work, a resumed twin). Now the
// hub adopts the process it finds running: same process, its scrollback, input and
// output routed again.
//
// The custom agent prints `started-<id>` once and then echoes every line it reads;
// its resume command would print `resumed-<id>`. One `started-`, no `resumed-`, and
// an echo after the restart prove the SAME process carried on.
test.describe('Terminal agent across a hub restart', () => {
  // The second case continues the first one's agent.
  test.describe.configure({ mode: 'serial' })
  const customModeId = 'hub-restart-e2e'
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    // Custom modes are idle-gated by TerminalStarter; `instant` mounts the agent.
    await mainWindow.evaluate(() =>
      window
        .getTrpcVanillaClient()
        .settings.set.mutate({ key: 'terminal_agent_startup', value: 'instant' })
    )
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Hub Restart',
      color: '#2563eb',
      path: TEST_PROJECT_PATH
    })
    await mainWindow.evaluate((id) => {
      return window.getTrpcVanillaClient().pty.agentsCreate.mutate({
        id,
        label: 'Echo CLI',
        type: 'custom',
        initialCommand: "sh -c 'echo started-{id}; while read l; do echo got:$l; done'",
        resumeCommand: "sh -c 'echo resumed-{id}; while read l; do echo got:$l; done'",
        defaultFlags: '',
        enabled: true
      })
    }, customModeId)
    const t = await s.createTask({
      projectId: p.id,
      title: 'Hub restart task',
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
    await mainWindow
      .evaluate((id) => window.getTrpcVanillaClient().pty.agentsDelete.mutate({ id }), customModeId)
      .catch(() => {})
    await mainWindow
      .evaluate(() =>
        window
          .getTrpcVanillaClient()
          .settings.set.mutate({ key: 'terminal_agent_startup', value: 'manual' })
      )
      .catch(() => {})
  })

  test('the restarted hub takes the running agent over: same process, output and input', async ({
    mainWindow: page
  }) => {
    test.setTimeout(120_000)
    const sessionId = getMainSessionId(taskId)
    const write = (data: string) =>
      page.evaluate(
        ({ id, d }) => window.getTrpcVanillaClient().pty.write.mutate({ sessionId: id, data: d }),
        { id: sessionId, d: data }
      )
    await openTaskTerminal(page, { projectAbbrev: 'HU', taskTitle: 'Hub restart task' })
    await waitForBufferContains(page, sessionId, 'started-', 30_000)
    await write('before\r')
    await waitForBufferContains(page, sessionId, 'got:before', 15_000)

    // Hub only: the computer (and so the agent) and this window stay up.
    const restarted = await page.evaluate(() =>
      (
        window as unknown as {
          api: { app: { restartSidecar: () => Promise<{ ok: boolean; error?: string }> } }
        }
      ).api.app.restartSidecar()
    )
    expect(restarted.ok).toBe(true)

    // The new hub has the session again — adopted, not started.
    await waitForPtySession(page, sessionId, 45_000)
    await write('after\r')
    await waitForBufferContains(page, sessionId, 'got:after', 20_000)

    const buffer = await readFullBuffer(page, sessionId)
    // Its scrollback from before the restart is still there…
    expect(buffer).toContain('got:before')
    // …and it is the same process: started once, never resumed or restarted.
    expect(buffer.match(/started-[0-9a-f-]{36}/g)).toHaveLength(1)
    expect(buffer).not.toContain('resumed-')
    // The open tab shows it live, never the "not attached" state.
    await expect(page.getByTestId('terminal-not-attached')).toHaveCount(0)
  })

  // The tab is opened again right after the restart: its own start (`pty.create`)
  // races the hub's adoption. Whichever wins, the computer must hand over the running
  // process (`adoptLive` on the start, `pty.adopt` on the adoption) — the start used
  // to make it REPLACE the agent (SIGHUP mid-work, a resumed twin).
  test('reopening the tab right after a restart never replaces the running agent', async ({
    mainWindow: page
  }) => {
    test.setTimeout(120_000)
    const sessionId = getMainSessionId(taskId)
    const write = (data: string) =>
      page.evaluate(
        ({ id, d }) => window.getTrpcVanillaClient().pty.write.mutate({ sessionId: id, data: d }),
        { id: sessionId, d: data }
      )
    await waitForPtySession(page, sessionId, 15_000)
    await closeAllTaskTabs(page)

    const restarted = await page.evaluate(() =>
      (
        window as unknown as {
          api: { app: { restartSidecar: () => Promise<{ ok: boolean; error?: string }> } }
        }
      ).api.app.restartSidecar()
    )
    expect(restarted.ok).toBe(true)
    await openTaskTerminal(page, { projectAbbrev: 'HU', taskTitle: 'Hub restart task' })

    await waitForPtySession(page, sessionId, 45_000)
    await write('again\r')
    await waitForBufferContains(page, sessionId, 'got:again', 20_000)
    const buffer = await readFullBuffer(page, sessionId)
    expect(buffer.match(/started-[0-9a-f-]{36}/g)).toHaveLength(1)
    expect(buffer).not.toContain('resumed-')
    expect(buffer).toContain('got:before')
  })
})
