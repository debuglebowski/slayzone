/**
 * Claude Code chat: prompts the agent puts to the user — permission, question,
 * plan approval — answered from the prompt dock against the scripted fake CLI.
 * Recorded real-CLI turns are replayed where they exist
 * (packages/shared/test-utils/fake-claude/transcripts).
 */
import { resetApp } from '../fixtures/electron'
import { echoTurn, ev, expect, reply, step, test, transcriptPath } from '../fixtures/chat'

const BUILD = { command: 'npm run build', description: 'Build the project' }
const REJECTED_PREFIX = "The user doesn't want to proceed with this tool use."

const COLOR = {
  question: 'Which color do you prefer?',
  header: 'Color',
  multiSelect: false,
  options: [
    { label: 'Red', description: 'Pick red' },
    { label: 'Blue', description: 'Pick blue' }
  ]
}

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
                step.request(
                  { tool_name: 'Bash', input: BUILD, tool_use_id: 'toolu_build' },
                  {
                    allow: [
                      step.emit(
                        ev.toolResult({ toolUseId: 'toolu_build', content: 'built' }),
                        ev.text('Build done.'),
                        ev.result({ text: 'Build done.' })
                      )
                    ],
                    deny: reply('Not building.')
                  }
                )
              ]
            ]
          }
        ]
      }
    })
    await t.send('build it')
    await expect
      .poll(async () => (await t.events()).some((e) => e.event.kind === 'permission-request'))
      .toBe(true)
    await expect(t.panel.getByText('npm run build').first()).toBeVisible()

    await t.panel
      .getByRole('button', { name: /^Yes\b/ })
      .first()
      .click({ timeout: 3_000 })
    await expect(t.panel.getByText('Build done.')).toBeVisible()
    expect((await t.run(0)).decisions()).toMatchObject([{ toolName: 'Bash', behavior: 'allow' }])
    // The answer is in the event log: a reload shows it, nothing re-asks.
    await expect
      .poll(async () => (await t.events()).some((e) => e.event.kind === 'permission-resolved'))
      .toBe(true)
  })

  test('AskUserQuestion: the answer reaches the CLI and the turn completes', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Chat question',
      scenario: { processes: [{ turns: [[step.replay(transcriptPath('ask-user-question'))]] }] }
    })
    await t.send('ask me about colors')
    await expect(t.panel.getByText('Which color do you prefer?').first()).toBeVisible()
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
    expect(run.replayMismatches()).toEqual([])
  })

  test('AskUserQuestion: Cancel declines the question, not the whole turn', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Chat question cancel',
      scenario: {
        processes: [
          {
            turns: [
              [
                step.emit(
                  ev.init(),
                  ev.toolUse({
                    id: 'toolu_q',
                    name: 'AskUserQuestion',
                    input: { questions: [COLOR] }
                  })
                ),
                step.request(
                  {
                    tool_name: 'AskUserQuestion',
                    input: { questions: [COLOR] },
                    tool_use_id: 'toolu_q',
                    requires_user_interaction: true
                  },
                  { allow: reply('Picked.'), deny: reply('No color then.') }
                )
              ]
            ],
            defaultTurn: echoTurn()
          }
        ]
      }
    })
    await t.send('ask me about colors')
    await expect(t.panel.getByText('Which color do you prefer?').first()).toBeVisible()

    await t.panel.getByRole('button', { name: 'Cancel' }).click()
    const run = await t.run(0, (r) => r.decisions().length === 1)
    expect(run.decisions().map((d) => d.behavior)).toEqual(['deny'])
    expect(run.decisions()[0]).toMatchObject({
      reply: { response: { message: expect.stringContaining(REJECTED_PREFIX) } }
    })
    expect(
      (run.decisions()[0].reply as { response: Record<string, unknown> }).response
    ).not.toHaveProperty('interrupt')
    // The turn carries on, in the same process.
    await expect(t.panel.getByText('No color then.')).toBeVisible()
    await expect(t.panel.getByText('User declined to answer questions')).toBeVisible()
    expect(run.signals()).toEqual([])
    expect(t.epoch.runs()).toHaveLength(1)
  })

  test('a pending question survives a renderer reload and stays answerable', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Chat question reload',
      scenario: { processes: [{ turns: [[step.replay(transcriptPath('ask-user-question'))]] }] }
    })
    await t.send('ask me about colors')
    await expect(t.panel.getByText('Which color do you prefer?').first()).toBeVisible()

    await t.reload()
    await expect(t.panel.getByText('Which color do you prefer?').first()).toBeVisible()
    await t.panel.getByRole('button', { name: /Blue/ }).click()
    await t.panel.getByRole('button', { name: 'Submit' }).click()
    const run = await t.run(0, (r) => r.decisions().length === 1)
    expect(run.decisions()[0]).toMatchObject({ toolName: 'AskUserQuestion', behavior: 'allow' })
  })

  test('ExitPlanMode: approving answers the request — the CLI leaves plan mode and carries out the plan', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Chat plan approval',
      scenario: {
        processes: [{ turns: [[step.replay(transcriptPath('exit-plan-allow'))]] }]
      }
    })
    await t.send('plan hello.txt')
    await expect(t.panel.getByText('Ready to code?')).toBeVisible()
    await expect(t.panel.getByText('Plan: create hello.txt').first()).toBeVisible()
    await t.panel.getByRole('button', { name: /^Yes, manually approve edits/ }).click()

    // The CLI is in its default mode now ("Ask before edits") and asks before the Write.
    await expect(
      t.panel.getByRole('button', { name: 'Agent mode: Ask before edits' })
    ).toBeVisible()
    await expect(t.panel.getByText('Create file')).toBeVisible()
    await t.panel.getByRole('button', { name: /^Yes$/ }).click()

    await expect(
      t.panel.getByText(/I created `?hello\.txt`? in the working directory/)
    ).toBeVisible()
    const run = await t.run(0, (r) => r.decisions().length === 2)
    expect(run.decisions().map((d) => [d.toolName, d.behavior])).toEqual([
      ['ExitPlanMode', 'allow'],
      ['Write', 'allow']
    ])
    expect(
      (run.decisions()[0].reply as { response: Record<string, unknown> }).response
    ).not.toHaveProperty('updatedPermissions')
    expect(run.replayMismatches()).toEqual([])
    // No hidden approval message, no respawn.
    expect(run.userMessages()).toEqual(['plan hello.txt'])
    expect(t.epoch.runs()).toHaveLength(1)
    await expect(t.panel.getByText('Approved · manually approve edits')).toBeVisible()
  })

  test('ExitPlanMode: "Tell Claude what to change" keeps it planning with the feedback', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Chat plan feedback',
      scenario: {
        processes: [
          {
            turns: [
              [
                step.emit(
                  ev.init(),
                  ev.toolUse({
                    id: 'toolu_plan',
                    name: 'ExitPlanMode',
                    input: { plan: 'Write hello.txt' }
                  })
                ),
                step.request(
                  {
                    tool_name: 'ExitPlanMode',
                    input: { plan: 'Write hello.txt' },
                    tool_use_id: 'toolu_plan',
                    requires_user_interaction: true
                  },
                  { allow: reply('Implementing.'), deny: reply('Revised the plan.') }
                )
              ]
            ]
          }
        ]
      }
    })
    await t.send('plan it')
    await t.panel.getByRole('button', { name: /^Tell Claude what to change/ }).click()
    const field = t.panel.getByRole('textbox', { name: 'Tell Claude what to change' })
    await field.fill('add a test too')
    await field.press('Enter')

    await expect(t.panel.getByText('Revised the plan.')).toBeVisible()
    const run = await t.run(0, (r) => r.decisions().length === 1)
    expect(run.decisions()[0]).toMatchObject({
      toolName: 'ExitPlanMode',
      behavior: 'deny',
      reply: {
        response: {
          message: expect.stringContaining(
            'To tell you how to proceed, the user said:\nadd a test too'
          )
        }
      }
    })
    await expect(t.panel.getByText('Keep planning: add a test too')).toBeVisible()
  })

  test('ExitPlanMode: approve with this feedback (shift+tab) approves, then sends the feedback', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Chat plan approve feedback',
      scenario: {
        processes: [
          {
            turns: [
              [
                step.emit(
                  ev.init(),
                  ev.toolUse({
                    id: 'toolu_plan',
                    name: 'ExitPlanMode',
                    input: { plan: 'Write hello.txt' }
                  })
                ),
                step.request(
                  {
                    tool_name: 'ExitPlanMode',
                    input: { plan: 'Write hello.txt' },
                    tool_use_id: 'toolu_plan',
                    requires_user_interaction: true
                  },
                  { allow: reply('Implementing.'), deny: reply('Revised the plan.') }
                )
              ]
            ],
            defaultTurn: echoTurn()
          }
        ]
      }
    })
    await t.send('plan it')
    await t.panel.getByRole('button', { name: /^Tell Claude what to change/ }).click()
    const field = t.panel.getByRole('textbox', { name: 'Tell Claude what to change' })
    await field.fill('add a test too')
    await field.press('Shift+Tab')

    const run = await t.run(0, (r) => r.userMessages().length === 2)
    expect(run.decisions()[0]).toMatchObject({ toolName: 'ExitPlanMode', behavior: 'allow' })
    const updates = (run.decisions()[0].reply as { response: { updatedPermissions?: unknown[] } })
      .response.updatedPermissions
    // auto mode when this account has it, otherwise auto-accept edits
    expect(updates).toEqual([
      {
        type: 'setMode',
        mode: expect.stringMatching(/^(auto|acceptEdits)$/),
        destination: 'session'
      }
    ])
    expect(run.userMessages()).toEqual(['plan it', 'add a test too'])
  })
})
