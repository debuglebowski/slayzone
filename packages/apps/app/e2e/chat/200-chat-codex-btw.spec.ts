/**
 * `/btw` side questions in Codex chat: an ephemeral `thread/fork` through the
 * last finished turn + one read-only, approval-free turn on it, answered in the
 * side card — never in the transcript, the main turn untouched. Against the fake
 * `codex app-server` (Claude Code: 199-chat-btw.spec.ts).
 */
import { resetApp } from '../fixtures/electron'
import { codexReply, cstep, expect, test } from '../fixtures/chat-codex'

test.describe('Chat /btw side questions (Codex)', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('mid-turn: an ephemeral fork through the last finished turn answers; the main turn keeps running', async ({
    codexChat
  }) => {
    const t = await codexChat.openTask({
      title: 'btw codex',
      scenario: {
        processes: [
          {
            turns: [codexReply('first answer'), [...codexReply('working on it'), cstep.hang()]],
            sideTurn: { reply: 'You first asked for a greeting.' }
          }
        ]
      }
    })
    await t.send('say hi')
    await expect(t.panel.getByText('first answer')).toBeVisible()
    await t.send('a long job')
    await expect(t.panel.getByText('working on it')).toBeVisible()

    await t.send('/btw what did I ask first?')
    const card = t.panel.getByTestId('side-question-card')
    await expect(card.getByText('You first asked for a greeting.')).toBeVisible()
    const run = await t.run(0, (r) => r.requests('thread/unsubscribe').length === 1)
    const fork = run.requests('thread/fork').find((r) => r.params.ephemeral === true)
    expect(fork?.params).toMatchObject({
      lastTurnId: run.turnIds()[0],
      ephemeral: true,
      approvalPolicy: 'never',
      sandbox: 'read-only'
    })
    // The main thread got only the two real messages; its turn still runs.
    const mainThread = fork?.params.threadId
    const sideThread = run.requests('thread/unsubscribe')[0].params.threadId
    expect(sideThread).not.toBe(mainThread)
    const turnStarts = run.requests('turn/start')
    expect(turnStarts.filter((r) => r.params.threadId === mainThread)).toHaveLength(2)
    expect(turnStarts.filter((r) => r.params.threadId === sideThread)).toHaveLength(1)
    await expect(t.stopButton).toBeVisible()
    await expect(t.panel.getByText('You first asked for a greeting.')).toHaveCount(1)
    const saved = JSON.stringify(await t.events())
    expect(saved).not.toContain('what did I ask first?')
    expect(saved).not.toContain('You first asked for a greeting.')
  })
})
