/**
 * Claude Code chat: answering prompts from the keyboard only (chat E, plan 4.6),
 * with the TUI's keys — the dock takes focus when a prompt arrives.
 * - Permission: ↓ + Enter picks the second row; Esc = No (the turn stops).
 * - Question: number keys pick (then the next question), ↓ + Enter toggles a
 *   multi-select, Tab moves to Submit, Enter submits.
 * - Plan approval: a number answers its row.
 * Against the scripted fake CLI.
 */
import { resetApp } from '../fixtures/electron'
import { echoTurn, ev, expect, reply, step, test, type Step } from '../fixtures/chat'

const BUILD = { command: 'npm run build', description: 'Build the project' }
const BASH_RULE = {
  type: 'addRules',
  rules: [{ toolName: 'Bash', ruleContent: 'npm run build' }],
  behavior: 'allow',
  destination: 'localSettings'
}
const COLOR = {
  question: 'Which color do you prefer?',
  header: 'Color',
  multiSelect: false,
  options: [
    { label: 'Red', description: 'Pick red' },
    { label: 'Blue', description: 'Pick blue' }
  ]
}
const FRUITS = {
  question: 'Which fruits?',
  header: 'Fruits',
  multiSelect: true,
  options: [
    { label: 'Apple', description: '' },
    { label: 'Pear', description: '' }
  ]
}

function promptTurn(
  request: Parameters<typeof step.request>[0],
  then: { allow?: Step[]; deny?: Step[] }
): Step[] {
  return [
    step.emit(
      ev.init(),
      ev.toolUse({ id: request.tool_use_id, name: request.tool_name, input: request.input })
    ),
    step.request(request, then)
  ]
}

const bash = (id: string) =>
  promptTurn(
    {
      tool_name: 'Bash',
      input: BUILD,
      tool_use_id: id,
      description: BUILD.description,
      permission_suggestions: [BASH_RULE]
    },
    {
      allow: [
        step.emit(
          ev.toolResult({ toolUseId: id, content: 'built' }),
          ev.text('Build done.'),
          ev.result({ text: 'Build done.' })
        )
      ],
      deny: reply('Not building.')
    }
  )

test.describe('Chat prompt keys', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('permission: ↓ Enter picks the second row; Esc is No and stops the turn', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Permission keys',
      scenario: {
        processes: [{ turns: [bash('toolu_b1'), bash('toolu_b2')], defaultTurn: echoTurn() }]
      }
    })
    await t.send('build it')
    await expect(t.page.locator('[data-prompt-dock]')).toBeFocused()
    await t.page.keyboard.press('ArrowDown')
    await t.page.keyboard.press('Enter')
    await expect(t.panel.getByText('Build done.')).toBeVisible()
    expect((await t.run(0)).decisions()[0]).toMatchObject({
      behavior: 'allow',
      reply: { response: { updatedPermissions: [BASH_RULE] } }
    })

    await t.send('build again')
    await expect(t.page.locator('[data-prompt-dock]')).toBeFocused()
    await t.page.keyboard.press('Escape')
    const run = await t.run(0, (r) => r.decisions().length === 2)
    expect(run.decisions()[1]).toMatchObject({
      behavior: 'deny',
      reply: { response: { interrupt: true } }
    })
    await expect(t.page.locator('[data-prompt-dock]')).toHaveCount(0)
  })

  test('question: numbers, ↓ Enter, Tab to Submit, Enter submits', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Question keys',
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
                    input: { questions: [COLOR, FRUITS] }
                  })
                ),
                step.request(
                  {
                    tool_name: 'AskUserQuestion',
                    input: { questions: [COLOR, FRUITS] },
                    tool_use_id: 'toolu_q',
                    requires_user_interaction: true
                  },
                  { allow: reply('Picked.'), deny: reply('No answer then.') }
                )
              ]
            ],
            defaultTurn: echoTurn()
          }
        ]
      }
    })
    await t.send('ask me')
    await expect(t.page.locator('[data-prompt-dock]')).toBeFocused()
    const keys = t.page.keyboard
    await keys.press('2') // Blue, then on to the fruits
    await keys.press('1') // Apple
    await keys.press('ArrowDown')
    await keys.press('Enter') // Pear
    await keys.press('Tab') // Submit
    await keys.press('Enter')
    await expect(t.panel.getByText('Picked.')).toBeVisible()
    expect((await t.run(0)).decisions()[0]).toMatchObject({
      toolName: 'AskUserQuestion',
      behavior: 'allow',
      reply: {
        response: {
          updatedInput: {
            answers: { 'Which color do you prefer?': 'Blue', 'Which fruits?': 'Apple, Pear' }
          }
        }
      }
    })
  })

  test('plan approval: a number answers its row', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Plan keys',
      scenario: {
        processes: [
          {
            turns: [
              promptTurn(
                {
                  tool_name: 'ExitPlanMode',
                  input: { plan: '1. Write hello.txt' },
                  tool_use_id: 'toolu_plan',
                  requires_user_interaction: true
                },
                { allow: reply('Coding now.'), deny: reply('Planning more.') }
              )
            ],
            defaultTurn: echoTurn()
          }
        ]
      }
    })
    await t.send('plan it')
    await expect(t.panel.getByText('Ready to code?')).toBeVisible()
    await expect(t.page.locator('[data-prompt-dock]')).toBeFocused()
    await t.page.keyboard.press('2') // "Yes, manually approve edits"
    await expect(t.panel.getByText('Coding now.')).toBeVisible()
    expect((await t.run(0)).decisions()[0]).toMatchObject({
      toolName: 'ExitPlanMode',
      behavior: 'allow'
    })
  })
})
