/**
 * Codex chat: Stop. Like the TUI, Stop must interrupt the turn IN PLACE
 * (`turn/interrupt` naming the running turn, the process stays); a respawn is
 * not a Stop. Plus the end of a process that dies with a request in flight
 * (audit #3 extra: a late "result" after "exited" flipping dead → error).
 */
import { resetApp } from '../fixtures/electron'
import type { CodexChatTask } from '../fixtures/chat-codex'
import {
  codexEchoTurn,
  cstep,
  cx,
  expect,
  knownBug,
  streamReply,
  test
} from '../fixtures/chat-codex'

/** Today's Stop (chat-handlers `stopTurn` without `liveInterrupt`): SIGTERM + respawn. */
const STOP_RESPAWNS = {
  audit: 'Codex Stop does nothing',
  fixedBy: 'Codex stop',
  what:
    'Stop on Codex kills the app-server and respawns it (codex-chat liveInterrupt:false) instead of ' +
    'turn/interrupt in place, like the TUI'
}

/** Stop reached the agent: an interrupt arrived, or the process was signalled. */
async function stopReached(t: CodexChatTask): Promise<void> {
  await t.run(0, (r) => r.interrupts().length > 0 || r.signals().length > 0)
}

/** The respawn today's Stop starts (scripted, so the guard does not mask the bug). */
const RESPAWN = { defaultTurn: codexEchoTurn() }

test.describe('Codex chat stop', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('Stop mid-turn sends turn/interrupt for the running turn; the process stays', async ({
    codexChat
  }) => {
    const t = await codexChat.openTask({
      title: 'Codex stop mid-turn',
      scenario: {
        processes: [
          {
            turns: [
              [
                ...streamReply(['working ', 'on it'], { id: 'msg_w' }),
                cstep.emit(cx.commandStarted({ id: 'exec-long', command: 'sleep 20' })),
                cstep.hang()
              ]
            ],
            defaultTurn: codexEchoTurn()
          },
          RESPAWN
        ]
      }
    })
    await t.send('a long job')
    await expect(t.panel.getByText('working on it')).toBeVisible()
    await t.stopButton.click()

    await stopReached(t)
    await expect(t.sendButton).toBeVisible()
    await expect(t.panel.getByText('working on it')).toBeVisible()
    await expect
      .poll(async () => (await t.events()).some((e) => e.event.kind === 'interrupted'))
      .toBe(true)

    knownBug(STOP_RESPAWNS)
    const run = await t.run(0)
    expect(run.signals()).toEqual([])
    expect(run.interrupts()).toEqual([{ turnId: run.turnIds()[0], current: run.turnIds()[0] }])

    await t.send('next one')
    await expect(t.panel.getByText('echo: next one')).toBeVisible()
    expect(t.epoch.runs()).toHaveLength(1)
  })

  test('Stop while an approval waits: interrupted in place, the request withdrawn, nothing answers it late', async ({
    codexChat
  }) => {
    const cmd = { id: 'exec-pending', command: 'touch z.txt' }
    const t = await codexChat.openTask({
      title: 'Codex stop pending approval',
      scenario: {
        processes: [
          {
            turns: [[cstep.emit(cx.commandStarted(cmd)), cstep.approveCommand(cmd)]],
            defaultTurn: codexEchoTurn()
          },
          RESPAWN
        ]
      }
    })
    await t.send('make a file')
    await t.run(0, (r) => r.serverRequests().length === 1)
    await t.stopButton.click()
    await stopReached(t)
    await expect(t.sendButton).toBeVisible()

    knownBug(STOP_RESPAWNS)
    const run = await t.run(0)
    expect(run.signals()).toEqual([])
    expect(run.interruptedTurns()).toHaveLength(1)
    // The server withdrew it (serverRequest/resolved after turn/completed, 0.159.2).
    expect(run.abandonedRequests()).toEqual([0])
    await t.send('next')
    await expect(t.panel.getByText('echo: next')).toBeVisible()
    expect(run.lateReplies()).toEqual([])
    expect(t.epoch.runs()).toHaveLength(1)
  })

  test('Stop before the turn has an id still interrupts that turn, in place', async ({
    codexChat
  }) => {
    const t = await codexChat.openTask({
      title: 'Codex stop early',
      scenario: {
        processes: [
          {
            // The turn/start reply and turn/started (both carry the id) come late:
            // the window right after Send.
            turnStart: { replyDelayMs: 2_500 },
            turns: [[cstep.hang()]],
            defaultTurn: codexEchoTurn()
          },
          RESPAWN
        ]
      }
    })
    await t.send('a long job')
    const run = await t.run(0, (r) => r.requests('turn/start').length === 1)
    await expect(t.stopButton).toBeVisible()
    await t.stopButton.click()
    await stopReached(t)
    await expect(t.sendButton).toBeVisible({ timeout: 10_000 })

    // Today the respawn hides it; the driver half (codex-chat-session.fake.test.ts)
    // shows the in-place path then sends no turn/interrupt before the id is known.
    knownBug(STOP_RESPAWNS)
    expect(run.signals()).toEqual([])
    await t.run(0, (r) => r.turnIds().length === 1, 5_000)
    await expect
      .poll(() => run.interrupts().map((i) => i.turnId), { timeout: 3_000 })
      .toEqual([run.turnIds()[0]])
    expect(t.epoch.runs()).toHaveLength(1)
  })

  test('a process that dies with a request in flight stays ended, not error (no late result)', async ({
    codexChat
  }) => {
    const t = await codexChat.openTask({
      title: 'Codex dies mid-request',
      scenario: {
        processes: [{ turnStart: { replyDelayMs: 60_000 }, defaultTurn: codexEchoTurn() }]
      }
    })
    await t.send('hello')
    const run = await t.run(0, (r) => r.requests('turn/start').length === 1)
    process.kill(run.pid, 'SIGKILL')

    const restart = t.panel.getByRole('button', { name: /Session ended, click to restart/ })
    await expect(restart).toBeVisible({ timeout: 10_000 })
    await expect
      .poll(async () => (await t.events()).some((e) => e.event.kind === 'process-exit'))
      .toBe(true)
    // Give a late event from the dead process time to land.
    await t.page.waitForTimeout(1_500)
    const events = await t.events()
    const exitAt = events.findIndex((e) => e.event.kind === 'process-exit')
    const after = events.slice(exitAt + 1).map((e) => e.event.kind)
    expect(after.filter((k) => k === 'result' || k === 'error')).toEqual([])
    await expect(restart).toBeVisible()
  })
})
