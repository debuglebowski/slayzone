/**
 * Claude Code chat: a prompt's life (plan 2.2, 2.4–2.6) — its state comes from
 * the event log (reload keeps a pending prompt answerable and an answered one
 * answered), the CLI withdrawing it shows it expired, every control request the
 * app doesn't implement is answered at once, questions with previews, and the
 * task's "needs you" flag following the prompt. Against the scripted fake CLI.
 */
import { resetApp } from '../fixtures/electron'
import { ev, expect, reply, step, test, transcriptPath, type Step } from '../fixtures/chat'

const BUILD = { command: 'npm run build', description: 'Build the project' }

function bashTurn(): Step[] {
  return [
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
}

test.describe('Chat prompt lifecycle', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('a pending permission survives a renderer reload and stays answerable', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Prompt reload pending',
      scenario: { processes: [{ turns: [bashTurn()] }] }
    })
    await t.send('build it')
    await expect(t.panel.getByText('Bash command')).toBeVisible()
    await t.reload()
    await expect(t.panel.getByText('Bash command')).toBeVisible()
    await t.panel.getByRole('button', { name: /^Yes$/ }).click()
    await expect(t.panel.getByText('Build done.')).toBeVisible()
    expect((await t.run(0)).decisions()).toMatchObject([{ behavior: 'allow' }])
  })

  test('an answered permission stays answered after a reload: no card, its outcome shown', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Prompt reload answered',
      scenario: { processes: [{ turns: [bashTurn()] }] }
    })
    await t.send('build it')
    await t.panel.getByRole('button', { name: /^Yes$/ }).click()
    await expect(t.panel.getByText('Build done.')).toBeVisible()
    await t.reload()
    await expect(t.panel.getByText('Build done.')).toBeVisible()
    await expect(t.panel.getByText('Allowed', { exact: true })).toBeVisible()
    await expect(t.panel.locator('[data-prompt-dock]')).toHaveCount(0)
    expect((await t.run(0)).decisions()).toHaveLength(1)
  })

  test('a live interrupt while a prompt waits: the CLI withdraws it and the card shows it expired', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Prompt cancelled',
      scenario: { processes: [{ turns: [bashTurn()] }] }
    })
    await t.send('build it')
    await expect(t.panel.getByText('Bash command')).toBeVisible()
    // The live interrupt (chat.interrupt: the warm process keeps running).
    await t.page.evaluate((o) => window.getTrpcVanillaClient().chat.interrupt.mutate(o), t.opts())

    const run = await t.run(0, (r) => r.cancels().length === 1)
    await expect
      .poll(async () => (await t.events()).some((e) => e.event.kind === 'permission-cancelled'))
      .toBe(true)
    await expect(t.panel.locator('[data-prompt-dock]')).toHaveCount(0)
    await expect(t.panel.getByText('Expired', { exact: true })).toBeVisible()
    expect(run.decisions()).toEqual([])
    expect(t.epoch.runs()).toHaveLength(1)
  })

  test('Stop while a prompt waits (the process is replaced): the card shows it expired', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Prompt expired by respawn',
      scenario: { processes: [{ turns: [bashTurn()] }, { defaultTurn: reply('fresh process') }] }
    })
    await t.send('build it')
    await expect(t.panel.getByText('Bash command')).toBeVisible()
    await t.stopButton.click()
    await t.run(1)
    await expect(t.panel.locator('[data-prompt-dock]')).toHaveCount(0)
    await expect(t.panel.getByText('Expired', { exact: true })).toBeVisible()
    expect((await t.run(0)).decisions()).toEqual([])
  })

  test('a control request the app does not implement is answered at once (no 30 s stall)', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Unknown control request',
      scenario: {
        processes: [
          {
            turns: [
              [
                step.hostRequest(
                  { subtype: 'hook_callback', callback_id: 'ups', input: {} },
                  5_000
                ),
                ...reply('Hook skipped, carrying on.')
              ]
            ]
          }
        ]
      }
    })
    await t.send('go')
    await expect(t.panel.getByText('Hook skipped, carrying on.')).toBeVisible()
    const replies = (await t.run(0)).hostReplies()
    expect(replies).toMatchObject([{ subtype: 'hook_callback', reply: { subtype: 'error' } }])
  })

  test("AskUserQuestion with previews: the focused option's preview, notes ride along", async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Question previews',
      scenario: {
        processes: [{ turns: [[step.replay(transcriptPath('ask-user-question-preview'))]] }]
      }
    })
    await t.send('ask me about layouts')
    await expect(t.panel.getByText('Which page layout do you prefer?').first()).toBeVisible()
    await t.panel.getByRole('button', { name: /^Stacked/ }).click()
    await expect(t.panel.locator('pre', { hasText: 'Header' }).first()).toBeVisible()
    await t.panel.getByPlaceholder('Add notes on this design…').fill('keep the header slim')
    await t.panel.getByRole('button', { name: 'Submit' }).click()

    const run = await t.run(0, (r) => r.decisions().length === 1)
    expect(run.decisions()[0]).toMatchObject({
      behavior: 'allow',
      reply: {
        response: {
          updatedInput: {
            answers: { 'Which page layout do you prefer?': 'Stacked' },
            annotations: {
              'Which page layout do you prefer?': {
                preview: expect.stringContaining('Header'),
                notes: 'keep the header slim'
              }
            }
          }
        }
      }
    })
    expect(run.replayMismatches()).toEqual([])
    await expect(t.panel.getByText('Stacked', { exact: true }).last()).toBeVisible()
  })

  test('AskUserQuestion: "Chat about this" hands the questions back to Claude', async ({
    chat
  }) => {
    const QUESTION = {
      question: 'Which color do you prefer?',
      header: 'Color',
      multiSelect: false,
      options: [
        { label: 'Red', description: '' },
        { label: 'Blue', description: '' }
      ]
    }
    const t = await chat.openTask({
      title: 'Question clarify',
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
                    input: { questions: [QUESTION] }
                  })
                ),
                step.request(
                  {
                    tool_name: 'AskUserQuestion',
                    input: { questions: [QUESTION] },
                    tool_use_id: 'toolu_q',
                    requires_user_interaction: true
                  },
                  { allow: reply('Thanks.'), deny: reply('What would you like to clarify?') }
                )
              ]
            ]
          }
        ]
      }
    })
    await t.send('ask me')
    await t.panel.getByRole('button', { name: 'Chat about this' }).click()
    await expect(t.panel.getByText('What would you like to clarify?')).toBeVisible()
    expect((await t.run(0)).decisions()[0]).toMatchObject({
      behavior: 'deny',
      reply: {
        response: { message: expect.stringContaining('The user wants to clarify these questions.') }
      }
    })
    await expect(t.panel.getByText('User asked Claude for more questions')).toBeVisible()
  })

  test('"needs you": the task is flagged while a prompt waits and unflagged once answered', async ({
    chat,
    electronApp
  }) => {
    // After the answer the tool keeps running for a while, then the turn ends.
    const t = await chat.openTask({
      title: 'Prompt attention',
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
                      step.sleep(4_000),
                      step.emit(
                        ev.toolResult({ toolUseId: 'toolu_build', content: 'built' }),
                        ev.text('Build done.'),
                        ev.result({ text: 'Build done.' })
                      )
                    ]
                  }
                )
              ]
            ]
          }
        ]
      }
    })
    const flag = () =>
      electronApp.evaluate(async ({}, id) => {
        const d = (globalThis as Record<string, unknown>).__db as {
          all: (sql: string, params?: unknown[]) => Promise<Array<{ needs_attention: number }>>
        }
        const rows = await d.all('SELECT needs_attention FROM tasks WHERE id = ?', [id])
        return rows[0]?.needs_attention
      }, t.taskId)
    await t.send('build it')
    await expect(t.panel.getByText('Bash command')).toBeVisible()
    await expect.poll(flag).toBe(1)
    await t.panel.getByRole('button', { name: /^Yes$/ }).click()
    // Answered: the agent is working again — not "needs you".
    await expect.poll(flag, { timeout: 3_000 }).toBe(0)
    // The finished turn flags the task again, as the TUI's does.
    await expect(t.panel.getByText('Build done.')).toBeVisible({ timeout: 10_000 })
    await expect.poll(flag).toBe(1)
  })
})
