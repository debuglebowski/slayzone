/**
 * Codex chat engine (X1) through the real app: the chat ops the UI calls
 * (`chat.*` over tRPC → hub → computer → driver → fake codex app-server) for
 * live command output, compact, rewind, fork, the Sessions switch, the
 * account's models and the context meter's data. The fake answers the thread
 * requests the way codex-cli 0.159.2 does (spike 2026-10-30, fake-codex README).
 */
import { resetApp } from '../fixtures/electron'
import {
  codexEchoTurn,
  codexReply,
  cstep,
  cx,
  expect,
  test,
  type CodexChatTask
} from '../fixtures/chat-codex'

/** The tab's saved user messages' ids, in order. */
async function messageIds(t: CodexChatTask): Promise<string[]> {
  return (await t.events())
    .filter((e) => e.event.kind === 'user-message' && !e.event.history)
    .map((e) => String(e.event.id))
}

test.describe('Codex chat engine', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('live command output: the running command’s output is readable while it runs (command-task path)', async ({
    codexChat
  }) => {
    const cmd = { id: 'exec-live', command: 'npm run build', output: 'step 1\nstep 2\n' }
    const t = await codexChat.openTask({
      title: 'Codex live output',
      scenario: {
        processes: [
          {
            turns: [
              [
                cstep.emit(cx.commandStarted(cmd)),
                cstep.emit(cx.commandOutput(cmd.id, 'step 1\n')),
                cstep.sleep(2_500),
                cstep.emit(cx.commandOutput(cmd.id, 'step 2\n')),
                cstep.emit(cx.commandCompleted(cmd)),
                ...codexReply('Built.')
              ]
            ]
          }
        ]
      }
    })
    await t.send('build it')
    const poll = () =>
      t.page.evaluate(
        (tabId) =>
          window
            .getTrpcVanillaClient()
            .chat.commandTaskOutput.query({ tabId, taskId: 'exec-live' }),
        t.tabId
      )
    await expect
      .poll(poll, { timeout: 5_000 })
      .toMatchObject({ state: 'running', output: 'step 1\n' })
    await expect(t.panel.getByText('Built.')).toBeVisible()
    expect(await poll()).toMatchObject({ state: 'ended', output: 'step 1\nstep 2\n' })
    const saved = (await t.events()).map((e) => e.event)
    expect(saved.filter((e) => e.kind === 'command-task').map((e) => e.status)).toEqual([
      'running',
      'completed'
    ])
    // Live, not saved per chunk: no event carries the streamed output.
    expect(
      saved.some((e) => JSON.stringify(e).includes('step 1') && e.kind !== 'tool-result')
    ).toBe(false)
  })

  test('compact: /compact runs thread/compact/start and shows Claude’s compact events', async ({
    codexChat
  }) => {
    const t = await codexChat.openTask({
      title: 'Codex compact',
      scenario: { processes: [{ defaultTurn: codexEchoTurn() }] }
    })
    await t.send('hello')
    await expect(t.panel.getByText('echo: hello')).toBeVisible()
    await t.send('/compact')
    const run = await t.run(0, (r) => r.compactions() === 1)
    expect(run.userTexts()).toEqual(['hello'])
    await expect
      .poll(async () =>
        (await t.events()).map((e) => e.event.kind).filter((k) => k.startsWith('compact'))
      )
      .toEqual(['compact-status', 'compact-boundary', 'compact-status'])
    await t.send('after')
    await expect(t.panel.getByText('echo: after')).toBeVisible()
    expect(t.epoch.runs()).toHaveLength(1)
  })

  test('rewind (edit & resend): the message and its turn leave the thread, its text comes back', async ({
    codexChat
  }) => {
    const t = await codexChat.openTask({
      title: 'Codex rewind',
      scenario: { processes: [{ defaultTurn: codexEchoTurn() }] }
    })
    await t.send('first')
    await expect(t.panel.getByText('echo: first')).toBeVisible()
    await t.send('second')
    await expect(t.panel.getByText('echo: second')).toBeVisible()
    const [, second] = await messageIds(t)
    const res = await t.page.evaluate(
      ({ o, messageId }) =>
        window.getTrpcVanillaClient().chat.rewind.mutate({
          ...o,
          messageId,
          scope: 'before',
          conversation: true,
          files: false
        }),
      { o: t.opts(), messageId: second }
    )
    expect(res).toMatchObject({ prefillText: 'second', files: null })
    const run = await t.run(0, (r) => r.reverts().length === 1)
    expect(run.reverts()[0]).toMatchObject({ beforeTurnId: run.turnIds()[1], dropped: 1 })
    expect(run.clientMessageIds()).toEqual(await messageIds(t))
    expect(t.epoch.runs()).toHaveLength(1)
  })

  test('fork from a message: a new thread through that turn, the task records it; Sessions switches back with its past', async ({
    codexChat
  }) => {
    const t = await codexChat.openTask({
      title: 'Codex fork',
      scenario: {
        processes: [
          { defaultTurn: codexEchoTurn() },
          { defaultTurn: codexEchoTurn() },
          { defaultTurn: codexEchoTurn() }
        ]
      }
    })
    await t.send('first')
    await expect(t.panel.getByText('echo: first')).toBeVisible()
    await t.send('second')
    await expect(t.panel.getByText('echo: second')).toBeVisible()
    const original = (await t.run(0)).threadId!
    const [first] = await messageIds(t)

    const forked = await t.page.evaluate(
      ({ o, messageId }) => window.getTrpcVanillaClient().chat.fork.mutate({ ...o, messageId }),
      { o: t.opts(), messageId: first }
    )
    const run1 = await t.run(1, (r) => r.forks().length === 1)
    expect(run1.forks()[0]).toMatchObject({ from: original, kept: 1 })
    await expect
      .poll(async () => (await t.conversations()).map((c) => c.origin))
      .toContain('slay-spawned-fork')
    expect(forked.fromConversationId).toBe(original)
    expect(await t.storedThread()).toBe(run1.forks()[0].threadId)

    // Sessions: back to the original; its past comes from Codex (thread/turns/list).
    await t.page.evaluate(
      ({ o, conversationId }) =>
        window
          .getTrpcVanillaClient()
          .chat.switchConversation.mutate({ ...o, conversationId, sourceMode: 'codex-chat' }),
      { o: t.opts(), conversationId: original }
    )
    const run2 = await t.run(2, (r) => r.requests('thread/turns/list').length > 0)
    expect(run2.resumedThread).toBe(original)
    await expect
      .poll(async () =>
        (await t.events())
          .filter((e) => e.event.kind === 'user-message' && e.event.history)
          .map((e) => e.event.text)
      )
      .toEqual(['first', 'second'])
    await t.send('third')
    await expect(t.panel.getByText('echo: third')).toBeVisible()
  })

  test('models and the context meter: model/list is stored for the picker; token usage is saved', async ({
    codexChat
  }) => {
    const t = await codexChat.openTask({
      title: 'Codex models + usage',
      scenario: {
        processes: [
          {
            turns: [[...codexReply('counted'), cstep.emit(cx.tokenUsage(4_000, 50, 258_400))]]
          }
        ]
      }
    })
    await expect
      .poll(() =>
        t.page.evaluate(
          async (taskId) =>
            (
              await window
                .getTrpcVanillaClient()
                .chat.getModels.query({ taskId, mode: 'codex-chat' })
            ).map((m) => [m.id, m.isDefault]),
          t.taskId
        )
      )
      .toEqual([
        ['gpt-6.1-sol', true],
        ['gpt-6-astra', false],
        ['gpt-6-luna', false]
      ])
    await t.send('count')
    await expect(t.panel.getByText('counted')).toBeVisible()
    await expect
      .poll(async () =>
        (await t.events())
          .map((e) => e.event)
          .filter((e) => e.kind === 'context-usage')
          .at(-1)
      )
      .toMatchObject({ kind: 'context-usage', contextWindow: 258_400 })
    const usage = (await t.events()).map((e) => e.event).filter((e) => e.kind === 'result')
    expect(usage.every((e) => e.totalCostUsd === 0)).toBe(true)
  })
})
