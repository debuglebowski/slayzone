/**
 * Codex chat: a process that ends, the restart that follows, and settings that
 * change between turns (model, mode: applied per turn/start, no respawn).
 */
import { resetApp } from '../fixtures/electron'
import {
  codexEchoTurn,
  codexReply,
  cstep,
  expect,
  knownBug,
  streamReply,
  test
} from '../fixtures/chat-codex'

test.describe('Codex chat restart', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('a crash mid-turn ends the session with its stderr; restart resumes the same thread', async ({
    codexChat
  }) => {
    const t = await codexChat.openTask({
      title: 'Codex crash restart',
      scenario: {
        processes: [
          {
            turns: [
              [
                ...streamReply(['about ', 'to crash'], { id: 'msg_c' }),
                cstep.stderr('panic: fake-codex crashed on purpose\n'),
                cstep.exit(1)
              ]
            ]
          },
          { defaultTurn: codexEchoTurn() }
        ]
      }
    })
    await t.send('do the thing')
    await expect(t.panel.getByText('about to crash')).toBeVisible()
    const first = await t.run(0, (r) => r.exit()?.code === 1)

    const restart = t.panel.getByRole('button', { name: /Session ended, click to restart/ })
    await expect(restart).toBeVisible()
    await expect(t.composer).toBeDisabled()
    await expect(t.panel.getByText('panic: fake-codex crashed on purpose')).toBeVisible()

    await restart.click()
    const second = await t.run(1)
    await expect(t.composer).toBeEnabled()
    await t.send('still there?')
    await expect(t.panel.getByText('echo: still there?')).toBeVisible()
    // Saved, whatever the timeline shows.
    expect(
      (await t.events()).some(
        (e) => e.event.kind === 'assistant-text' && e.event.text === 'about to crash'
      )
    ).toBe(true)

    knownBug({
      fixedBy: 'Codex resume',
      what:
        'a restart starts a NEW Codex thread (the first thread id was recorded foreign-observed): Codex forgets ' +
        'the conversation, and the new session id makes the timeline hide every earlier turn (chat-timeline turn-init restart)'
    })
    expect(second.resumedThread).toBe(first.threadId)
    expect(second.requests('thread/start')).toHaveLength(0)
    await expect(t.panel.getByText('about to crash')).toBeVisible({ timeout: 2_000 })
  })

  test('a process that exits cleanly between turns ends the session (no error)', async ({
    codexChat
  }) => {
    const t = await codexChat.openTask({
      title: 'Codex clean exit',
      scenario: {
        processes: [{ turns: [[...codexReply('bye now'), cstep.sleep(200), cstep.exit(0)]] }]
      }
    })
    await t.send('say bye')
    await expect(t.panel.getByText('bye now')).toBeVisible()
    await t.run(0, (r) => r.exit()?.code === 0)
    await expect(
      t.panel.getByRole('button', { name: /Session ended, click to restart/ })
    ).toBeVisible()
    const kinds = (await t.events()).map((e) => e.event.kind)
    expect(kinds).toContain('process-exit')
    expect(kinds.filter((k) => k === 'error')).toEqual([])
  })

  test('a model change applies to the next turn without a respawn', async ({ codexChat }) => {
    const t = await codexChat.openTask({
      title: 'Codex model change',
      scenario: { processes: [{ defaultTurn: codexEchoTurn() }] }
    })
    await t.send('one')
    await expect(t.panel.getByText('echo: one')).toBeVisible()
    await t.page.evaluate(
      (o) => window.getTrpcVanillaClient().chat.setModel.mutate({ ...o, chatModel: 'gpt-5.4' }),
      t.opts()
    )
    await t.send('two')
    await expect(t.panel.getByText('echo: two')).toBeVisible()
    const run = await t.run(0, (r) => r.requests('turn/start').length === 2)
    expect(run.requests('turn/start')[0].params.model).toBe('gpt-5.5')
    expect(run.requests('turn/start')[1].params.model).toBe('gpt-5.4')
    expect(t.epoch.runs()).toHaveLength(1)
  })

  test('the model picker offers the models the server lists (model/list)', async ({
    codexChat
  }) => {
    const t = await codexChat.openTask({
      title: 'Codex model list',
      scenario: {
        processes: [
          {
            methods: {
              'model/list': {
                result: {
                  data: [
                    {
                      id: 'gpt-6-luna',
                      model: 'gpt-6-luna',
                      displayName: 'GPT-6 Luna',
                      isDefault: true
                    },
                    {
                      id: 'gpt-6.1-sol',
                      model: 'gpt-6.1-sol',
                      displayName: 'GPT-6.1 Sol',
                      isDefault: false
                    }
                  ],
                  nextCursor: null
                }
              }
            },
            defaultTurn: codexEchoTurn()
          }
        ]
      }
    })
    await t.send('one')
    await expect(t.panel.getByText('echo: one')).toBeVisible()
    const run = await t.run(0)
    // Precondition: chat sends a model the CLI never listed (chat-model-catalog.ts default).
    expect(run.requests('turn/start')[0].params.model).toBe('gpt-5.5')

    knownBug({
      fixedBy: 'Codex models',
      what:
        'the Codex model list is hardcoded (gpt-5.5 default, 5.4, 5.4-mini, 5.3-codex) and model/list is never ' +
        'asked: on a ChatGPT login every one of them is refused ("not supported when using Codex with a ChatGPT account")'
    })
    expect(run.requests('model/list').length).toBeGreaterThan(0)
    await t.panel.getByRole('button', { name: /^Chat model:/ }).click({ timeout: 2_000 })
    await expect(t.page.getByRole('menuitem', { name: /GPT-6 Luna/ })).toBeVisible({
      timeout: 2_000
    })
  })

  test('a mode change applies to the next turn without a respawn', async ({ codexChat }) => {
    const t = await codexChat.openTask({
      title: 'Codex mode change',
      scenario: { processes: [{ defaultTurn: codexEchoTurn() }] }
    })
    await t.send('one')
    await expect(t.panel.getByText('echo: one')).toBeVisible()
    await t.page.evaluate(
      (o) =>
        window.getTrpcVanillaClient().chat.setMode.mutate({ ...o, chatMode: 'approval-required' }),
      t.opts()
    )
    await t.send('two')
    await expect(t.panel.getByText('echo: two')).toBeVisible()
    const run = await t.run(0, (r) => r.requests('turn/start').length === 2)
    expect(run.requests('turn/start')[1].params).toMatchObject({
      approvalPolicy: 'untrusted',
      sandboxPolicy: { type: 'readOnly' }
    })
    expect(t.epoch.runs()).toHaveLength(1)
  })
})
