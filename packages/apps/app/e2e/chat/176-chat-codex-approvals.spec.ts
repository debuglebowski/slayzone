/**
 * Codex chat: approval cards round-trip through the real UI. The fake sends the
 * server→client requests codex-cli 0.159.2 sends (recipes approval-exec,
 * approval-file) and blocks until the app answers.
 *
 * Audit #1 ("Codex approval-required mode can't be used") is fixed: codex-chat
 * has prompt cards and the driver answers in each request's own vocabulary
 * (X1). The rows a Codex card offers are still Claude's until X2's Codex prompt
 * variant lands: the two tests that need Codex's own rows are known bugs.
 */
import { resetApp } from '../fixtures/electron'
import {
  codexEchoTurn,
  codexReply,
  cstep,
  cx,
  expect,
  test,
  type CodexChatTask,
  type CodexStep
} from '../fixtures/chat-codex'

const CMD = { id: 'exec-approve', command: 'touch a.txt' }
/** Once the bug is fixed the card is there at once; short waits keep the expected failure cheap. */
const CARD_MS = 3_000

/** X1 drew the card (promptCards); Codex's own rows are X2's (prompt dock Codex variant). */
/** Precondition of every card test: the fake asked, and the app has the request. */
async function requestArrived(t: CodexChatTask): Promise<void> {
  await t.run(0, (r) => r.serverRequests().length === 1)
  await expect
    .poll(async () => (await t.events()).some((e) => e.event.kind === 'permission-request'))
    .toBe(true)
}

/** A command that needs approval; each answer continues differently. */
function approvalTurn(): CodexStep[] {
  return [
    cstep.emit(cx.commandStarted(CMD)),
    cstep.approveCommand(CMD, {
      accept: [cstep.emit(cx.commandCompleted(CMD)), ...codexReply('Created a.txt.')],
      acceptForSession: [
        cstep.emit(cx.commandCompleted(CMD)),
        ...codexReply('Created a.txt, always.')
      ],
      decline: [
        cstep.emit(cx.commandCompleted({ ...CMD, status: 'declined' })),
        ...codexReply('Not creating it.')
      ],
      cancel: [cstep.endTurn('interrupted')]
    })
  ]
}

test.describe('Codex chat approvals', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('approve a command: the card answers accept and the turn goes on', async ({ codexChat }) => {
    const t = await codexChat.openTask({
      title: 'Codex approve',
      scenario: { processes: [{ turns: [approvalTurn()], defaultTurn: codexEchoTurn() }] }
    })
    await t.send('make a file')
    await requestArrived(t)
    // X0 bug #1 (fixed by X1): the request has a card, and its answer reaches Codex.
    const yes = t.panel.getByRole('button', { name: /^Yes$/ })
    await yes.click({ timeout: CARD_MS })
    await expect(t.panel.getByText('Created a.txt.')).toBeVisible()
    const run = await t.run(0, (r) => r.requestReplies().length === 1)
    expect(run.requestReplies()).toMatchObject([
      { requestId: 0, method: 'item/commandExecution/requestApproval', decision: 'accept' }
    ])
    // The card is answered: no buttons left, the next message works.
    await expect(yes).toHaveCount(0)
    await t.send('next')
    await expect(t.panel.getByText('echo: next')).toBeVisible()
    expect(t.epoch.runs()).toHaveLength(1)
  })

  test('decline a command: the card answers decline and the turn goes on', async ({
    codexChat
  }) => {
    const t = await codexChat.openTask({
      title: 'Codex decline',
      scenario: { processes: [{ turns: [approvalTurn()], defaultTurn: codexEchoTurn() }] }
    })
    await t.send('make a file')
    await requestArrived(t)
    await t.panel.getByRole('button', { name: /^No$/ }).click({ timeout: CARD_MS })
    const run = await t.run(0, (r) => r.requestReplies().length === 1)
    expect(run.requestReplies()[0].decision).toBe('decline')
    await expect(t.panel.getByText('Not creating it.')).toBeVisible()
    await expect(t.sendButton).toBeVisible()
  })

  test('the card says what is asked: the command, not the protocol method', async ({
    codexChat
  }) => {
    const t = await codexChat.openTask({
      title: 'Codex card content',
      scenario: { processes: [{ turns: [approvalTurn()] }] }
    })
    await t.send('make a file')
    await requestArrived(t)
    // X0 bug #1 (fixed by X1): the request has a card, and its answer reaches Codex.
    await expect(t.panel.getByRole('button', { name: /^Yes$/ })).toBeVisible({ timeout: CARD_MS })
    // Once drawn: the generic "Tool use" card would title it with the raw
    // JSON-RPC method (prompt-options.ts default branch) — it must show the command.
    await expect(t.panel.getByText('item/commandExecution/requestApproval')).toHaveCount(0)
    await expect(t.panel.getByText('touch a.txt', { exact: false }).first()).toBeVisible({
      timeout: 2_000
    })
  })

  test('"allow for this session" is offered and answers acceptForSession', async ({
    codexChat
  }) => {
    const t = await codexChat.openTask({
      title: 'Codex allow session',
      scenario: { processes: [{ turns: [approvalTurn()] }] }
    })
    await t.send('make a file')
    await requestArrived(t)
    await expect(t.panel.getByRole('button', { name: /^Yes$/ })).toBeVisible({ timeout: CARD_MS })
    // Once drawn: the request offers acceptForSession (`availableDecisions`), and
    // the driver must send it (codex-chat-session.fake.test.ts has the driver half).
    const always = t.panel.getByRole('button', { name: /don.t ask again|this session|always/i })
    await expect(always).toBeVisible({ timeout: CARD_MS })
    await always.click()
    const run = await t.run(0, (r) => r.requestReplies().length === 1, 5_000)
    expect(run.requestReplies()[0].decision).toBe('acceptForSession')
  })

  test('approve a file change', async ({ codexChat }) => {
    const change = {
      id: 'patch-ok',
      changes: [{ path: 'x.txt', kind: 'add' as const, diff: 'one\n' }]
    }
    const t = await codexChat.openTask({
      title: 'Codex file approval',
      scenario: {
        processes: [
          {
            turns: [
              [
                cstep.emit(cx.fileChangeStarted(change)),
                cstep.approveFileChange(change.id, {
                  accept: [
                    cstep.emit(cx.fileChangeCompleted(change)),
                    ...codexReply('Wrote x.txt.')
                  ],
                  decline: codexReply('Skipped x.txt.')
                })
              ]
            ]
          }
        ]
      }
    })
    await t.send('write x')
    await requestArrived(t)
    // X0 bug #1 (fixed by X1): the request has a card, and its answer reaches Codex.
    await t.panel.getByRole('button', { name: /^Yes$/ }).click({ timeout: CARD_MS })
    await expect(t.panel.getByText('Wrote x.txt.')).toBeVisible()
    const run = await t.run(0, (r) => r.requestReplies().length === 1)
    expect(run.requestReplies()[0]).toMatchObject({
      method: 'item/fileChange/requestApproval',
      decision: 'accept'
    })
  })

  test('a legacy approval (applyPatchApproval) is answered with a ReviewDecision', async ({
    codexChat
  }) => {
    const t = await codexChat.openTask({
      title: 'Codex legacy approval',
      scenario: {
        processes: [
          {
            turns: [
              [
                cstep.request(
                  'applyPatchApproval',
                  {
                    conversationId: '{{threadId}}',
                    callId: 'call-legacy',
                    fileChanges: { '{{cwd}}/l.txt': { type: 'add', content: 'legacy\n' } },
                    reason: null,
                    grantRoot: null
                  },
                  { default: codexReply('Legacy answered.') }
                )
              ]
            ]
          }
        ]
      }
    })
    await t.send('legacy patch')
    await requestArrived(t)
    // X0 bug #1 (fixed by X1): the request has a card, and its answer reaches Codex.
    await t.panel.getByRole('button', { name: /^Yes$/ }).click({ timeout: CARD_MS })
    const run = await t.run(0, (r) => r.requestReplies().length === 1)
    await expect(t.panel.getByText('Legacy answered.')).toBeVisible()
    // The driver half (codex-protocol-drift.test.ts): a legacy request is answered
    // with its schema's ReviewDecision (approved/denied), not accept/decline.
    expect(run.requestReplies()[0].decision).toBe('approved')
  })
})
