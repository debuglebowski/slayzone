/**
 * Codex chat: reopening a stored conversation (`thread/resume`) — success, a
 * thread the server does not have (codex-cli 0.159.2, recipe resume-missing:
 * `-32600 no rollout found for thread id …`), and a resume that fails for
 * another reason (audit #2 "Codex is worse": every failure is treated as "not
 * found" and the conversation is dropped for good).
 */
import { resetApp } from '../fixtures/electron'
import { codexEchoTurn, codexReply, expect, test } from '../fixtures/chat-codex'

const STORED = '0b6c1a52-5f6e-4d55-9c7e-2a9a3f1e6d02'

/** What a finished earlier turn left in `chat_events`. */
const HISTORY = [
  { kind: 'user-message', text: 'an earlier question' },
  { kind: 'assistant-text', messageId: 'm-old', text: 'an earlier answer' }
]

test.describe('Codex chat resume', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('a stored thread is resumed and the conversation continues', async ({ codexChat }) => {
    const t = await codexChat.openTask({
      title: 'Codex resume ok',
      conversationId: STORED,
      seedEvents: HISTORY,
      scenario: {
        threads: [STORED],
        processes: [{ turns: [codexReply('continuing where we left off')] }]
      }
    })
    await expect(t.panel.getByText('an earlier answer')).toBeVisible()
    const run = await t.run(0)
    expect(run.resumedThread).toBe(STORED)
    expect(run.requests('thread/start')).toHaveLength(0)

    await t.send('go on')
    await expect(t.panel.getByText('continuing where we left off')).toBeVisible()
    expect((await t.run(0, (r) => r.userTexts().length === 1)).userTexts()).toEqual(['go on'])
    expect(t.epoch.runs()).toHaveLength(1)
  })

  test('a thread the server does not have: a fresh thread, the message answered, a notice naming Codex', async ({
    codexChat
  }) => {
    const t = await codexChat.openTask({
      title: 'Codex resume missing',
      conversationId: STORED,
      seedEvents: HISTORY,
      scenario: {
        // No `threads`: the fake answers thread/resume like 0.159.2 does for an unknown id.
        processes: [{}, { defaultTurn: codexEchoTurn() }]
      }
    })
    const failed = await t.run(0, (r) => r.requests('thread/resume').length === 1)
    expect(failed.resumedThread).toBe(STORED)
    const fresh = await t.run(1, (r) => r.threadId !== undefined)
    expect(fresh.requests('thread/start')).toHaveLength(1)

    await t.send('are you there?')
    await expect(t.panel.getByText('echo: are you there?')).toBeVisible()
    // The old history is still shown.
    await expect(t.panel.getByText('an earlier answer')).toBeVisible()
    const notice = (await t.events()).find(
      (e) => e.event.kind === 'notice' && e.event.code === 'resume-failed-fresh-start'
    )
    expect(notice).toBeTruthy()

    // X0 bug #7 (fixed): the notice names Codex.
    expect(String(notice?.event.text)).not.toContain('Claude')
    expect(String(notice?.event.text)).toContain('Codex')
  })

  test('audit #2: a resume that fails for another reason keeps the conversation', async ({
    codexChat
  }) => {
    const t = await codexChat.openTask({
      title: 'Codex resume transient',
      conversationId: STORED,
      seedEvents: HISTORY,
      scenario: {
        threads: [STORED],
        processes: [
          // A transient failure (network), not "no rollout found".
          {
            handshake: {
              threadResume: {
                error: { code: -32000, message: 'stream disconnected before completion' }
              }
            }
          },
          // Retry: the same thread again.
          { defaultTurn: codexEchoTurn() }
        ]
      }
    })
    await t.run(0, (r) => r.requests('thread/resume').length === 1)
    // X0 bug #6 / audit #2 (fixed): not a fresh start — the conversation is kept,
    // the notice says why, and Retry resumes it.
    await expect
      .poll(async () =>
        (await t.events()).some(
          (e) => e.event.kind === 'notice' && e.event.code === 'resume-failed-kept'
        )
      )
      .toBe(true)
    expect(
      (await t.events()).some(
        (e) => e.event.kind === 'notice' && e.event.code === 'resume-failed-fresh-start'
      )
    ).toBe(false)
    await expect(
      t.panel.getByText('stream disconnected before completion', { exact: false })
    ).toBeVisible()
    expect(await t.storedThread()).toBe(STORED)
    await t.panel.getByRole('button', { name: /Session ended, click to restart/ }).click()
    const next = await t.run(1, (r) => r.notifications().includes('initialized'))
    await t.send('still there?')
    await expect(t.panel.getByText('echo: still there?')).toBeVisible()
    expect(next.requests('thread/start')).toHaveLength(0)
    expect(next.resumedThread).toBe(STORED)
    // The earlier history is still shown.
    await expect(t.panel.getByText('an earlier answer')).toBeVisible()
  })
})
