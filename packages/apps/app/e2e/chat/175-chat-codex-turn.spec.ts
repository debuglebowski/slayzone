/**
 * Codex chat: a turn through the real UI against the fake `codex app-server`
 * (fixtures/chat-codex.ts, packages/shared/test-utils/fake-codex/README.md).
 * Streaming, what is saved, reload, tool cards, and audit #5 (a long streamed
 * reply wiping the history).
 */
import { resetApp } from '../fixtures/electron'
import {
  codexEchoTurn,
  codexReply,
  commandTurn,
  cstep,
  cx,
  expect,
  streamReply,
  test
} from '../fixtures/chat-codex'

test.describe('Codex chat turn', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('a reply streams in and is saved once; one process serves every turn', async ({
    codexChat
  }) => {
    const t = await codexChat.openTask({
      title: 'Codex turn basics',
      scenario: {
        processes: [
          {
            turns: [codexReply('Hello from the fake Codex, streamed word by word.', { gapMs: 60 })],
            defaultTurn: codexEchoTurn()
          }
        ]
      }
    })
    await t.send('say hello')
    await expect(
      t.panel.getByText('Hello from the fake Codex, streamed word by word.')
    ).toBeVisible()

    const run = await t.run(0, (r) => r.userTexts().length === 1)
    expect(run.userTexts()).toEqual(['say hello'])
    expect(run.requests('thread/start')).toHaveLength(1)
    expect(run.requests('thread/resume')).toHaveLength(0)
    expect(run.requests('turn/start')[0].params).toMatchObject({
      threadId: run.threadId,
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'workspaceWrite' }
    })

    await t.send('and again')
    await expect(t.panel.getByText('echo: and again')).toBeVisible()
    expect(t.epoch.runs()).toHaveLength(1)

    // Saved: one assistant-text per Codex item, never one per streamed delta.
    const events = await t.events()
    const kinds = events.map((e) => e.event.kind)
    expect(kinds).toEqual(
      expect.arrayContaining(['user-message', 'turn-init', 'assistant-text', 'result'])
    )
    expect(kinds.filter((k) => k === 'assistant-text')).toHaveLength(2)
    expect(kinds.filter((k) => k === 'result')).toHaveLength(2)
  })

  test("the thread id Codex minted is stored as THIS task's conversation (what a restart resumes)", async ({
    codexChat
  }) => {
    const t = await codexChat.openTask({
      title: 'Codex thread stored',
      scenario: { processes: [{ defaultTurn: codexEchoTurn() }] }
    })
    await t.send('hello')
    await expect(t.panel.getByText('echo: hello')).toBeVisible()
    const run = await t.run(0)
    // Precondition: the transport saw the thread id and recorded it.
    await expect
      .poll(async () => (await t.conversations()).map((c) => c.conversationId))
      .toContain(run.threadId)

    // X0 bug #4 (fixed): the id Codex minted is the tab's own conversation.
    const row = (await t.conversations()).find((c) => c.conversationId === run.threadId)
    expect(row?.origin).toBe('slay-spawned-fresh')
    expect(await t.storedThread()).toBe(run.threadId)
  })

  test('reloading mid-turn keeps the history once and the turn keeps streaming', async ({
    codexChat
  }) => {
    const t = await codexChat.openTask({
      title: 'Codex reload mid-turn',
      scenario: {
        processes: [
          {
            turns: [
              [
                ...streamReply(['part one ', 'of the answer'], { id: 'msg_a' }),
                cstep.sleep(3_000),
                ...streamReply(['part two ', 'of the answer'], { id: 'msg_b' })
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
    expect(t.epoch.runs()).toHaveLength(1)
  })

  test('audit #5: a long streamed reply is saved as ONE event and the older history stays', async ({
    codexChat
  }) => {
    // 1,000 rows of earlier conversation: before full history (plan 4.3) the tab
    // kept 2,000 events, and a reply saved per delta pushed these out.
    const HISTORY = Array.from({ length: 500 }, (_, i) => [
      { kind: 'user-message', text: `old question ${i}` },
      { kind: 'assistant-text', messageId: `m-old-${i}`, text: `old answer ${i}` }
    ]).flat()
    const chunks = Array.from({ length: 1_200 }, (_, i) => `w${i} `)
    const t = await codexChat.openTask({
      title: 'Codex long reply',
      seedEvents: HISTORY,
      scenario: { processes: [{ turns: [streamReply(chunks, { id: 'msg_long' })] }] }
    })
    await t.send('write a lot')
    await expect(t.panel.getByText('w1199', { exact: false })).toBeVisible({ timeout: 20_000 })
    await expect
      .poll(async () => (await t.events()).some((e) => e.event.kind === 'result'))
      .toBe(true)

    const events = await t.events()
    const replies = events.filter(
      (e) => e.event.kind === 'assistant-text' && e.event.messageId === 'msg_long'
    )
    expect(replies).toHaveLength(1)
    expect(String(replies[0].event.text).trim().split(' ')).toHaveLength(1_200)
    // Nothing of the older history was dropped to make room.
    expect(events[0]).toMatchObject({
      seq: 0,
      event: { kind: 'user-message', text: 'old question 0' }
    })
    expect(events.length).toBeLessThan(HISTORY.length + 20)
  })

  test('a command card shows the command and its output, not the raw item JSON', async ({
    codexChat
  }) => {
    const t = await codexChat.openTask({
      title: 'Codex command card',
      scenario: {
        processes: [
          {
            turns: [
              commandTurn(
                { id: 'exec-card', command: 'npm test', chunks: ['PASS  3 tests\n'] },
                'The suite passed.'
              )
            ]
          }
        ]
      }
    })
    await t.send('run the tests')
    await expect(t.panel.getByText('The suite passed.')).toBeVisible()
    // Precondition: the card for this command exists.
    await expect(t.panel.getByText('npm test', { exact: false }).first()).toBeVisible()

    // A Bash-like card: the command as a title, no JSON keys from the item.
    await expect(t.panel.getByText(/"command"\s*:/)).toHaveCount(0)
    await expect(t.panel.getByText(/"cwd"\s*:/)).toHaveCount(0)
  })

  test('a file change card shows the diff, not the raw item JSON', async ({ codexChat }) => {
    const change = {
      id: 'patch-1',
      changes: [
        {
          path: 'notes.txt',
          kind: 'update' as const,
          diff: '@@ -1 +1 @@\n-hello world\n+hello codex\n'
        }
      ]
    }
    const t = await codexChat.openTask({
      title: 'Codex file card',
      scenario: {
        processes: [
          {
            turns: [
              [
                cstep.emit(cx.fileChangeStarted(change)),
                cstep.emit(cx.fileChangeCompleted(change)),
                ...codexReply('Edited notes.txt.')
              ]
            ]
          }
        ]
      }
    })
    await t.send('edit the note')
    await expect(t.panel.getByText('Edited notes.txt.')).toBeVisible()
    await expect(t.panel.getByText('notes.txt', { exact: false }).first()).toBeVisible()

    await expect(t.panel.getByText(/"changes"\s*:/)).toHaveCount(0)
    await expect(t.panel.getByText('hello codex', { exact: true }).first()).toBeVisible({
      timeout: 2_000
    })
  })

  test('the composer names Codex, not Claude', async ({ codexChat }) => {
    const t = await codexChat.openTask({
      title: 'Codex placeholder',
      scenario: { processes: [{ defaultTurn: codexEchoTurn() }] }
    })
    await expect(t.composer).toBeEnabled()
    await expect(t.composer).toHaveAttribute('placeholder', 'Ask Codex anything…', {
      timeout: 2_000
    })
  })

  test('e2e isolation: the app runs Codex with a per-worker CODEX_HOME, not the real ~/.codex', async ({
    electronApp
  }) => {
    const env = await electronApp.evaluate(() => ({
      codexHome: process.env.CODEX_HOME ?? null,
      home: process.env.HOME ?? null
    }))
    expect(env.home).toBeTruthy()
    // A real codex an e2e starts writes trust entries, sessions and history into
    // CODEX_HOME: the worker's own, never the developer's ~/.codex (X0 bug #16).
    expect(env.codexHome).toMatch(/\.e2e-runtime/)
    expect(env.codexHome).not.toBe(`${env.home}/.codex`)
  })
})
