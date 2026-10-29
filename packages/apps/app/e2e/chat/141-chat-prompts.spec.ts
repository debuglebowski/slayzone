/**
 * Claude Code chat: prompts the agent puts to the user — permission, question,
 * plan approval — against the scripted fake CLI. Recorded real-CLI turns are
 * replayed where they exist (packages/shared/test-utils/fake-claude/transcripts).
 */
import { resetApp } from '../fixtures/electron'
import { echoTurn, ev, expect, knownBug, reply, step, test, transcriptPath } from '../fixtures/chat'

const BUILD = { command: 'npm run build', description: 'Build the project' }

test.describe('Chat prompts', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('a permission request for Bash shows an approval card', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Chat permission',
      scenario: {
        processes: [
          {
            turns: [
              [
                step.emit(ev.init(), ev.toolUse({ id: 'toolu_build', name: 'Bash', input: BUILD })),
                {
                  request: { tool_name: 'Bash', input: BUILD, tool_use_id: 'toolu_build' },
                  then: {
                    allow: [
                      step.emit(
                        ev.toolResult({ toolUseId: 'toolu_build', content: 'built' }),
                        ev.text('Build done.'),
                        ev.result({ text: 'Build done.' })
                      )
                    ],
                    deny: reply('Not building.')
                  }
                }
              ]
            ]
          }
        ]
      }
    })
    await t.send('build it')
    // Preconditions: the request reached the app (persisted) and the tool card shows.
    await expect
      .poll(async () => (await t.events()).some((e) => e.event.kind === 'permission-request'))
      .toBe(true)
    await expect(t.panel.getByText('npm run build').first()).toBeVisible()

    // The server records the request and marks the session waiting; the only UI
    // that answers a request is the AskUserQuestion card. The CLI waits forever.
    knownBug({
      audit: '#1',
      fixedBy: '2.1',
      what: 'a Bash permission request has no approval card'
    })
    await t.panel
      .getByRole('button', { name: /^Yes\b/ })
      .first()
      .click({ timeout: 3_000 })
    await expect(t.panel.getByText('Build done.')).toBeVisible()
    expect((await t.run(0)).decisions()).toMatchObject([{ toolName: 'Bash', behavior: 'allow' }])
  })

  test('AskUserQuestion: the answer reaches the CLI and the turn completes', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Chat question',
      scenario: { processes: [{ turns: [[step.replay(transcriptPath('ask-user-question'))]] }] }
    })
    await t.send('ask me about colors')
    await expect(t.panel.getByText('Which color do you prefer?')).toBeVisible()
    await t.panel.getByRole('button', { name: /Blue/ }).click()
    await t.panel.getByRole('button', { name: 'Submit' }).click()

    const run = await t.run(0, (r) => r.decisions().length === 1)
    expect(run.decisions()[0]).toMatchObject({
      toolName: 'AskUserQuestion',
      behavior: 'allow',
      reply: { response: { updatedInput: { answers: { 'Which color do you prefer?': 'Blue' } } } }
    })
    // The recorded turn finishes with the model repeating the pick.
    await expect(t.panel.getByText('Blue', { exact: true }).last()).toBeVisible()
    expect(t.epoch.runs()).toHaveLength(1)
  })

  test('AskUserQuestion: Cancel declines the question, not the whole turn', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Chat question cancel',
      scenario: {
        processes: [
          { turns: [[step.replay(transcriptPath('ask-user-question'))]] },
          // Today's Cancel kills + resumes the agent; script the respawn so the
          // guard does not mask the real assertion.
          { defaultTurn: echoTurn() }
        ]
      }
    })
    await t.send('ask me about colors')
    await expect(t.panel.getByText('Which color do you prefer?')).toBeVisible()

    // Cancel calls abortAgent → abortAndPop: the process is killed and resumed.
    knownBug({
      fixedBy: '2.4',
      what: 'Cancel on a question kills the turn instead of declining the question'
    })
    await t.panel.getByRole('button', { name: 'Cancel' }).click()
    await expect
      .poll(
        () =>
          t.epoch
            .run(0)
            ?.decisions()
            .map((d) => d.behavior),
        { timeout: 3_000 }
      )
      .toEqual(['deny'])
    expect(t.epoch.run(0)?.signals()).toEqual([])
  })

  test('a pending question survives a renderer reload and stays answerable', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Chat question reload',
      scenario: { processes: [{ turns: [[step.replay(transcriptPath('ask-user-question'))]] }] }
    })
    await t.send('ask me about colors')
    await expect(t.panel.getByText('Which color do you prefer?')).toBeVisible()

    await t.reload()
    await expect(t.panel.getByText('Which color do you prefer?')).toBeVisible()
    await t.panel.getByRole('button', { name: /Blue/ }).click()
    await t.panel.getByRole('button', { name: 'Submit' }).click()
    const run = await t.run(0, (r) => r.decisions().length === 1)
    expect(run.decisions()[0]).toMatchObject({ toolName: 'AskUserQuestion', behavior: 'allow' })
  })

  test('ExitPlanMode: approving leaves plan mode and the plan is carried out', async ({ chat }) => {
    const plan = transcriptPath('exit-plan-deny')
    const t = await chat.openTask({
      title: 'Chat plan approval',
      scenario: {
        processes: [{ turns: [[step.replay(plan, { turn: 0 })], [step.replay(plan, { turn: 1 })]] }]
      }
    })
    await t.send('plan hello.txt')
    // The driver auto-denies ExitPlanMode; the card then offers approval.
    await expect(t.panel.getByText('Approve plan?')).toBeVisible()
    await expect(t.panel.getByText('Plan: create hello.txt').first()).toBeVisible()
    await t.panel.getByRole('button', { name: 'Approve & exit plan' }).click()

    await expect(
      t.panel.getByText(/I created `?hello\.txt`? in the working directory/)
    ).toBeVisible()
    const run = await t.run(0, (r) => r.userMessages().length === 2)
    // Mode switched live, no respawn.
    expect(run.controlRequests()).toContainEqual({
      subtype: 'set_permission_mode',
      mode: 'acceptEdits'
    })
    expect(t.epoch.runs()).toHaveLength(1)

    // Approval is a chat message carrying a marker the model reads as text.
    knownBug({
      fixedBy: '2.3',
      what: 'plan approval sends a hidden __slay_plan_approved__ text to the model'
    })
    expect(run.userMessages().join('\n')).not.toContain('__slay_plan_approved__')
  })
})
