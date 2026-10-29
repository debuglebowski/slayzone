/**
 * Claude Code chat: reopening an old conversation (`--resume`) — success, and each
 * kind of resume failure the transport's resume guard reacts to (audit #2): only
 * the CLI's "can't resume" signals are withheld, a fresh start re-sends the message,
 * and every other error is shown.
 *
 * The real CLI (2.1.312, transcript `resume-missing`) fails an unknown --resume at
 * startup: stderr "No conversation found with session ID: …", then
 * `result{error_during_execution, num_turns:0}`, exit 1. Here the first spawn
 * fails right AFTER it got the user's message — a slow-starting CLI — so the test
 * isolates what happens to that message.
 */
import { resetApp } from '../fixtures/electron'
import { echoTurn, ev, expect, reply, step, test, type Step } from '../fixtures/chat'

const CONVERSATION = '0b6c1a52-5f6e-4d55-9c7e-2a9a3f1e6d01'

/** What a finished earlier turn left in `chat_events`. */
const HISTORY = [
  { kind: 'user-message', text: 'an earlier question' },
  { kind: 'assistant-text', messageId: 'm-old', text: 'an earlier answer' },
  {
    kind: 'result',
    subtype: 'success',
    isError: false,
    durationMs: 1,
    durationApiMs: 1,
    numTurns: 1,
    totalCostUsd: 0,
    stopReason: null,
    terminalReason: null,
    text: 'an earlier answer',
    modelUsage: {},
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0
    },
    permissionDenials: []
  }
]

const NOT_FOUND = 'No conversation found with session ID: {{sessionId}}'

/** A resumed task whose first spawn plays `failure` on the first message. */
function resumeScenario(failure: Step[]) {
  return {
    processes: [
      { turns: [failure] },
      // The holding pen's fresh start (--session-id, no --resume).
      { defaultTurn: echoTurn() }
    ]
  }
}

test.describe('Chat resume', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('a stored conversation is resumed and continues', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Chat resume ok',
      conversationId: CONVERSATION,
      seedEvents: HISTORY,
      scenario: { processes: [{ turns: [reply('continuing where we left off')] }] }
    })
    await expect(t.panel.getByText('an earlier answer')).toBeVisible()
    const run = await t.run(0)
    expect(run.resumed).toBe(true)
    expect(run.sessionId).toBe(CONVERSATION)

    await t.send('and now?')
    await expect(t.panel.getByText('continuing where we left off')).toBeVisible()
    expect(t.epoch.runs()).toHaveLength(1)
  })

  const NOT_FOUND_KINDS: Array<{ name: string; failure: Step[] }> = [
    {
      name: 'stderr "No conversation found"',
      failure: [step.stderr(`${NOT_FOUND}\n`), step.exit(1)]
    },
    {
      name: 'an error result saying "No conversation found"',
      failure: [
        step.emit(
          ev.result({
            isError: true,
            subtype: 'error_during_execution',
            numTurns: 0,
            text: NOT_FOUND
          })
        ),
        step.exit(1)
      ]
    },
    {
      name: 'error_during_execution with 0 turns',
      failure: [
        step.emit(ev.result({ isError: true, subtype: 'error_during_execution', numTurns: 0 })),
        step.exit(1)
      ]
    }
  ]

  for (const kind of NOT_FOUND_KINDS) {
    test(`resume fails with ${kind.name}: fresh start, and the message is delivered`, async ({
      chat
    }) => {
      const t = await chat.openTask({
        title: `Chat resume ${kind.name}`,
        conversationId: CONVERSATION,
        seedEvents: HISTORY,
        scenario: resumeScenario(kind.failure)
      })
      await t.send('hello again')
      // The resumed spawn got the message and failed; the transport started fresh
      // (no --resume) and re-sent the message — the new conversation never had it.
      expect((await t.run(0, (r) => r.exit() !== undefined)).userMessages()).toEqual([
        'hello again'
      ])
      const fresh = await t.run(1)
      expect(fresh.resumed).toBe(false)
      await expect
        .poll(() => t.epoch.run(1)?.userMessages(), { timeout: 4_000 })
        .toEqual(['hello again'])
      await expect(t.panel.getByText('echo: hello again')).toBeVisible()
      // The history stays, and the user is told the conversation started over.
      await expect(t.panel.getByText('an earlier answer')).toBeVisible()
      await expect(
        t.panel.locator('[data-testid="chat-notice"][data-code="resume-failed-fresh-start"]')
      ).toBeVisible()
    })
  }

  test('a resumed first turn that fails for another reason shows the error', async ({ chat }) => {
    const authError = 'Invalid API key · Please run /login'
    const t = await chat.openTask({
      title: 'Chat resume other error',
      conversationId: CONVERSATION,
      seedEvents: HISTORY,
      scenario: {
        processes: [
          {
            turns: [
              [
                step.emit(
                  ev.init(),
                  ev.result({ isError: true, subtype: 'success', text: authError })
                ),
                step.exit(1)
              ]
            ]
          }
        ]
      }
    })
    await t.send('hello again')
    // Precondition: the CLI reported the error and exited.
    await t.run(0, (r) => r.exit()?.code === 1)

    // Not a resume failure: shown at once (the old holding pen staged it forever),
    // and readable in the timeline, not only inside the result footer.
    await expect(t.panel.getByText(authError)).toBeVisible({ timeout: 4_000 })
  })
})
