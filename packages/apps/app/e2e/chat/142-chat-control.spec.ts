/**
 * Claude Code chat: controlling a running turn — Stop, a live model change, and a
 * setting change that respawns the agent mid-turn — against the scripted fake CLI.
 */
import { resetApp } from '../fixtures/electron'
import { echoTurn, ev, expect, step, test } from '../fixtures/chat'

test.describe('Chat control', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('Stop before any output restores the prompt; the resumed agent answers the next message', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Chat stop early',
      scenario: {
        processes: [
          { turns: [[step.hang()]] },
          // Stop = abortAndPop: kill, then resume the same conversation.
          { defaultTurn: echoTurn() }
        ]
      }
    })
    await t.send('a long job')
    await t.run(0, (r) => r.userMessages().includes('a long job'))

    await t.stopButton.click()
    // Nothing had arrived yet, so the message is popped back into the composer.
    await expect(t.composer).toHaveValue('a long job')
    await t.run(0, (r) => r.signals().includes('SIGTERM'))
    // No init had echoed the session id yet, so there is nothing to resume: the
    // replacement starts fresh (the user's text is back in the composer).
    expect((await t.run(1)).resumed).toBe(false)

    await t.send('next one')
    await expect(t.panel.getByText('echo: next one')).toBeVisible()
  })

  test('Stop after output keeps the partial turn and ends it', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Chat stop late',
      scenario: {
        processes: [
          { turns: [[step.emit(ev.init(), ev.text('working on it')), step.hang()]] },
          { defaultTurn: echoTurn() }
        ]
      }
    })
    await t.send('a long job')
    await expect(t.panel.getByText('working on it')).toBeVisible()

    await t.stopButton.click()
    await expect(t.sendButton).toBeVisible()
    await t.run(1)
    // Progress had arrived: the turn stays (marked interrupted), nothing is restored.
    await expect(t.panel.getByText('working on it')).toBeVisible()
    await expect(t.panel.getByText('a long job')).toBeVisible()
    await expect(t.composer).toHaveValue('')
    await expect
      .poll(async () => (await t.events()).some((e) => e.event.kind === 'interrupted'))
      .toBe(true)

    await t.send('next one')
    await expect(t.panel.getByText('echo: next one')).toBeVisible()
  })

  test('a model change mid-turn applies live, without a respawn', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Chat model mid-turn',
      scenario: {
        processes: [
          {
            turns: [
              [
                step.emit(ev.init(), ev.text('thinking about it')),
                step.sleep(2_500),
                step.emit(ev.text('answered by {{model}}'), ev.result({ text: 'ok' }))
              ]
            ]
          }
        ]
      }
    })
    await t.send('question')
    await expect(t.panel.getByText('thinking about it')).toBeVisible()
    // The composer's model pill is locked while a turn runs…
    await expect(t.panel.getByRole('button', { name: /^Chat model:/ })).toBeDisabled()
    // …but the server accepts a change from any other client mid-turn.
    await t.page.evaluate(
      (o) => window.getTrpcVanillaClient().chat.setModel.mutate({ ...o, chatModel: 'sonnet' }),
      t.opts()
    )

    await expect(t.panel.getByText('answered by sonnet')).toBeVisible({ timeout: 10_000 })
    const run = await t.run(0)
    expect(run.controlRequests()).toContainEqual({ subtype: 'set_model', model: 'sonnet' })
    expect(t.epoch.runs()).toHaveLength(1)
  })

  test('a respawn mid-turn: late output of the replaced process never reaches the history', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Chat respawn overwrite',
      scenario: {
        processes: [
          {
            turns: [[step.emit(ev.init(), ev.text('gen1 working')), step.hang()]],
            // The replaced process keeps talking for ~1.5 s after SIGTERM — inside
            // the transport's 2 s kill grace — like a CLI flushing its output.
            onSigterm: [
              // Right away (inside the kill → respawn window) and again later.
              step.emit(ev.text('LATE-0 from the replaced process')),
              step.sleep(1_500),
              {
                emit: [
                  ev.text('LATE-1 from the replaced process'),
                  ev.text('LATE-2 from the replaced process'),
                  ev.text('LATE-3 from the replaced process')
                ],
                gapMs: 50
              }
            ]
          },
          {
            defaultTurn: [
              step.emit(ev.init(), ev.text('GEN2: {{userText}}'), ev.result({ text: 'done' }))
            ]
          }
        ]
      }
    })
    await t.send('start')
    await expect(t.panel.getByText('gen1 working')).toBeVisible()

    // `/effort` is handled by the composer even mid-turn; an effort change always
    // respawns a live agent (chat-handlers setEffort).
    await t.send('/effort high')
    await t.run(1)
    await t.send('after respawn')
    await expect(t.panel.getByText('GEN2: after respawn')).toBeVisible()
    // Preconditions: the old process really did emit its late events after the respawn.
    await t.run(0, (r) => r.stdoutLines().some((l) => l.includes('LATE-3')))
    await expect
      .poll(async () => (await t.events()).some((e) => e.event.kind === 'result'))
      .toBe(true)
    // Let any late write land before reading the store.
    await t.page.waitForTimeout(500)

    // Audit #3 (a replaced process's late events overwrite the new one's rows via
    // INSERT OR REPLACE) does NOT reproduce end to end: chat always spawns through
    // a computer, which re-spawns under the same session id and drops the replaced
    // child's output (apps/computer handlers/proc.ts `procs.get(id) !== session`),
    // both right after SIGTERM and later. This guards that; plan 1.1's hub-side
    // generation gate remains defence in depth.
    const texts = (await t.events()).map((e) => String(e.event.text ?? ''))
    expect(texts.filter((x) => x.includes('LATE-'))).toEqual([])
    expect(texts).toContain('after respawn')
    expect(texts).toContain('GEN2: after respawn')
  })
})
