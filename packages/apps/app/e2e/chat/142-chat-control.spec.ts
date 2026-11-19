/**
 * Claude Code chat: controlling a running turn — Stop (a live interrupt), a live
 * model change, and an explicit restart mid-turn — against
 * the scripted fake CLI.
 */
import { resetApp } from '../fixtures/electron'
import { expandActivities } from '../fixtures/chat-activity'
import { echoTurn, ev, expect, step, test } from '../fixtures/chat'

test.describe('Chat control', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('Stop before any output restores the prompt; the same agent answers the next message', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Chat stop early',
      scenario: {
        // Stop = a live interrupt: the process stays (chat A; 150 has the details).
        processes: [{ turns: [[step.hang()]], defaultTurn: echoTurn() }]
      }
    })
    await t.send('a long job')
    await t.run(0, (r) => r.userMessages().includes('a long job'))

    await t.stopButton.click()
    // Nothing had arrived yet, so the message is popped back into the composer…
    await expect(t.composer).toHaveValue('a long job')
    // …and the CLI forgot it (it may already have stored it).
    const run = await t.run(0, (r) => r.rewound().length === 1)
    expect(run.signals()).toEqual([])

    await t.composer.fill('')
    await t.send('next one')
    await expect(t.panel.getByText('echo: next one')).toBeVisible()
    expect(t.epoch.runs()).toHaveLength(1)
  })

  test('Stop after output keeps the partial turn and ends it', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Chat stop late',
      scenario: {
        processes: [
          {
            turns: [[step.emit(ev.init(), ev.text('working on it')), step.hang()]],
            defaultTurn: echoTurn()
          }
        ]
      }
    })
    await t.send('a long job')
    await expect(t.panel.getByText('working on it')).toBeVisible()

    await t.stopButton.click()
    await expect(t.sendButton).toBeVisible()
    await t.run(0, (r) => r.controlRequests('interrupt').length === 1)
    await expandActivities(t.panel)
    // Progress had arrived: the turn stays (marked interrupted), nothing is restored.
    await expect(t.panel.getByText('working on it')).toBeVisible()
    await expect(t.panel.getByText('a long job')).toBeVisible()
    await expect(t.composer).toHaveValue('')
    await expect
      .poll(async () => (await t.events()).some((e) => e.event.kind === 'interrupted'))
      .toBe(true)

    await t.send('next one')
    await expect(t.panel.getByText('echo: next one')).toBeVisible()
    expect(t.epoch.runs()).toHaveLength(1)
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
    // Model changes stay available during a turn and apply without replacing it.
    await expect(t.panel.getByRole('button', { name: /^Chat model:/ })).toBeEnabled()
    await t.page.evaluate(
      (o) => window.getTrpcVanillaClient().chat.setModel.mutate({ ...o, chatModel: 'sonnet' }),
      t.opts()
    )

    await expect(t.panel.getByText('answered by sonnet')).toBeVisible({ timeout: 10_000 })
    const run = await t.run(0)
    expect(run.controlRequests()).toContainEqual({ subtype: 'set_model', model: 'sonnet' })
    expect(t.epoch.runs()).toHaveLength(1)
  })

  test('a respawn mid-turn: the tail of the replaced process lands before the next process, never over it', async ({
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

    // Explicit restart replaces the process even while a turn is running.
    await t.page.evaluate((o) => window.getTrpcVanillaClient().chat.restart.mutate(o), t.opts())
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

    // Audit #3: a replaced process's late events overwrote the new one's rows
    // (INSERT OR REPLACE). The replacement starts only once the old process has
    // exited and its output is stored: the tail it wrote while draining is kept
    // (terminal DOMAIN.md: "replacement/close retains the final tail"), all of it
    // before the next process's spawn, once, in order; nothing of it after that.
    const rows = await t.events()
    const spawns = rows.filter((r) => r.event.kind === 'session-spawn').map((r) => r.seq)
    expect(spawns).toHaveLength(2)
    const next = spawns[1]
    const text = (r: (typeof rows)[number]) => String(r.event.text ?? '')
    const late = rows.filter((r) => text(r).includes('LATE-'))
    expect(late.map(text)).toEqual([0, 1, 2, 3].map((i) => `LATE-${i} from the replaced process`))
    expect(late.every((r) => r.seq < next)).toBe(true)
    const after = rows.filter((r) => r.seq > next)
    expect(after.some((r) => text(r).includes('LATE-'))).toBe(false)
    expect(after.map(text)).toContain('after respawn')
    expect(after.map(text)).toContain('GEN2: after respawn')
    expect(after.some((r) => r.event.kind === 'result')).toBe(true)
  })
})
