/**
 * Claude Code chat: a turn through the real UI, against the scripted fake CLI.
 * Harness + scenario API: fixtures/chat.ts, packages/shared/test-utils/fake-claude/README.md.
 */
import { resetApp } from '../fixtures/electron'
import { echoTurn, ev, expect, reply, step, test } from '../fixtures/chat'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

test.describe('Chat turn', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('a turn with a tool streams into the chat; one process serves every turn', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Chat turn basics',
      scenario: {
        processes: [
          {
            turns: [
              [
                step.emit(
                  ev.init(),
                  ev.toolUse({
                    id: 'toolu_1',
                    name: 'Bash',
                    input: { command: 'echo hi', description: 'Say hi' }
                  }),
                  ev.toolResult({ toolUseId: 'toolu_1', content: 'hi' }),
                  ev.text('All done: hi'),
                  ev.result({ text: 'All done: hi' })
                )
              ]
            ],
            defaultTurn: echoTurn()
          }
        ]
      }
    })

    await t.send('say hi')
    await expect(t.panel.getByText('All done: hi')).toBeVisible()
    await expect(t.panel.getByText('echo hi').first()).toBeVisible()

    // The spawn honours the chat transport's contract (claude-code-adapter.ts).
    const run = await t.run(0, (r) => r.userMessages().length === 1)
    expect(run.userMessages()).toEqual(['say hi'])
    expect(run.resumed).toBe(false)
    expect(run.sessionId).toMatch(UUID)

    // Second message: same process, no respawn.
    await t.send('and again')
    await expect(t.panel.getByText('echo: and again')).toBeVisible()
    expect(t.epoch.runs()).toHaveLength(1)

    // The conversation id the init echoed is what the task will resume next time.
    const events = await t.events()
    expect(events.map((e) => e.event.kind)).toEqual(
      expect.arrayContaining([
        'user-message',
        'turn-init',
        'tool-call',
        'tool-result',
        'assistant-text',
        'result'
      ])
    )
  })

  test('a new chat task runs in the permission mode its mode pill shows', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Chat mode pill',
      scenario: { processes: [{ defaultTurn: echoTurn() }] }
    })
    const run = await t.run(0)
    await expect(
      t.panel.getByRole('button', { name: 'Agent mode: Auto-accept edits' })
    ).toBeVisible()

    // Bug N2 (fixed): task create seeded `--allow-dangerously-skip-permissions`
    // into provider_config and those flags beat the chat mode, so no
    // `--permission-mode` was passed — the CLI started in `default` while the
    // pill said Auto-accept. The pills now own mode/model/effort flags.
    expect(run.flag('--permission-mode')).toBe('acceptEdits')
    expect(run.argv).not.toContain('--allow-dangerously-skip-permissions')
  })

  test('a send that spawns the agent reaches it (lazy spawn, manual startup)', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Chat lazy spawn',
      spawn: 'on-send',
      scenario: { processes: [{ turns: [reply('first reply')], defaultTurn: echoTurn() }] }
    })
    expect(t.epoch.runs()).toHaveLength(0)

    await t.send('first message')
    // The send spawned the fake, and the message that did it reached the agent:
    // the outbox writes only once the process is READY (the routed start is
    // confirmed by the computer and the driver has its IO) — it used to be
    // written a tick too early and dropped without an error.
    const run = await t.run(0, (r) => r.userMessages().includes('first message'))
    await expect(t.panel.getByText('first reply')).toBeVisible()
    await t.page.evaluate(
      (tabId) => window.getTrpcVanillaClient().chat.send.mutate({ tabId, text: 'probe' }),
      t.tabId
    )
    await t.run(0, (r) => r.userMessages().includes('probe'))
    expect(run.userMessages()).toEqual(['first message', 'probe'])
  })

  test('a character split across two stdout chunks renders intact', async ({ chat }) => {
    const text = 'héllo wörld 😀 done'
    const t = await chat.openTask({
      title: 'Chat utf8 split',
      scenario: {
        processes: [
          {
            turns: [
              [
                step.emit(ev.init()),
                step.emitSplit(ev.text(text), 150),
                step.emit(ev.result({ text }))
              ]
            ]
          }
        ]
      }
    })
    await t.send('say it')
    // Preconditions: the fake wrote the split event, and the app persisted a reply.
    await t.run(0, (r) =>
      r.entries.some((e) => e.kind === 'stdout' && typeof e.splitAtByte === 'number')
    )
    await expect
      .poll(async () => (await t.events()).filter((e) => e.event.kind === 'assistant-text').length)
      .toBe(1)

    // Decoded per stream, not per chunk (computer handlers/proc.ts): a multi-byte
    // character cut across chunks arrives whole.
    const persisted = (await t.events()).find((e) => e.event.kind === 'assistant-text')
    expect(persisted?.event.text).toBe(text)
    await expect(t.panel.getByText(text)).toBeVisible({ timeout: 3_000 })
  })

  test('reloading mid-turn keeps the history once and the turn keeps streaming', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Chat reload mid-turn',
      scenario: {
        processes: [
          {
            turns: [
              [
                step.emit(ev.init(), ev.text('part one of the answer')),
                step.sleep(3_000),
                step.emit(ev.text('part two of the answer'), ev.result({ text: 'done' }))
              ]
            ]
          }
        ]
      }
    })
    await t.send('long answer please')
    await expect(t.panel.getByText('part one of the answer')).toBeVisible()

    await t.reload()
    await expect(t.panel.getByText('long answer please')).toHaveCount(1)
    await expect(t.panel.getByText('part one of the answer')).toHaveCount(1)
    await expect(t.panel.getByText('part two of the answer')).toBeVisible({ timeout: 10_000 })
    await expect(t.sendButton).toBeVisible()
    // The agent survived the renderer reload: no respawn.
    expect(t.epoch.runs()).toHaveLength(1)
  })
})
