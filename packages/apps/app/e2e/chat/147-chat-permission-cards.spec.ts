/**
 * Claude Code chat: the approval card for regular tools (plan 2.1) — the TUI's
 * rows per tool, built from the request's permission_suggestions, its keys, and
 * the wire answer behind each row. Against the scripted fake CLI.
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

/** One turn: the tool call, its permission request, then the allow / deny branch. */
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

const builds = {
  allow: [
    step.emit(
      ev.toolResult({ toolUseId: 'toolu_build', content: 'built' }),
      ev.text('Build done.'),
      ev.result({ text: 'Build done.' })
    )
  ],
  deny: reply('Not building.')
}

test.describe('Chat permission cards', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('Bash: "don\'t ask again" sends the CLI\'s own suggestion; the tool card says what was allowed', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Bash always',
      scenario: {
        processes: [
          {
            turns: [
              promptTurn(
                {
                  tool_name: 'Bash',
                  input: BUILD,
                  tool_use_id: 'toolu_build',
                  description: BUILD.description,
                  permission_suggestions: [BASH_RULE]
                },
                builds
              )
            ]
          }
        ]
      }
    })
    await t.send('build it')
    await expect(t.panel.getByText('Bash command')).toBeVisible()
    await t.panel
      .getByRole('button', { name: 'Yes, and don’t ask again for: npm run build' })
      .click()
    await expect(t.panel.getByText('Build done.')).toBeVisible()
    const run = await t.run(0, (r) => r.decisions().length === 1)
    expect(run.decisions()[0]).toMatchObject({
      behavior: 'allow',
      reply: { response: { updatedPermissions: [BASH_RULE], updatedInput: BUILD } }
    })
    await expect(t.panel.getByText('Allowed · don’t ask again for: npm run build')).toBeVisible()
  })

  test('Bash: "No" stops the turn; the same process answers the next message', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Bash no',
      scenario: {
        processes: [
          {
            turns: [
              promptTurn({ tool_name: 'Bash', input: BUILD, tool_use_id: 'toolu_build' }, builds)
            ],
            defaultTurn: echoTurn()
          }
        ]
      }
    })
    await t.send('build it')
    await t.panel.getByRole('button', { name: /^No$/ }).click()

    const run = await t.run(0, (r) => r.decisions().length === 1)
    expect(run.decisions()[0]).toMatchObject({
      behavior: 'deny',
      reply: { response: { interrupt: true } }
    })
    await expect(t.panel.getByText('Turn interrupted')).toBeVisible()
    await expect(t.panel.getByText('Not building.')).toHaveCount(0)

    await t.send('next')
    await expect(t.panel.getByText('echo: next')).toBeVisible()
    expect(t.epoch.runs()).toHaveLength(1)
  })

  test('keys: the card takes focus; 1 picks the first row', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Bash keys',
      scenario: {
        processes: [
          {
            turns: [
              promptTurn({ tool_name: 'Bash', input: BUILD, tool_use_id: 'toolu_build' }, builds)
            ]
          }
        ]
      }
    })
    await t.send('build it')
    await expect(t.panel.getByText('Bash command')).toBeVisible()
    await t.page.keyboard.press('1')
    await expect(t.panel.getByText('Build done.')).toBeVisible()
    expect((await t.run(0)).decisions()).toMatchObject([{ behavior: 'allow' }])
  })

  test("Tab to amend: rejects with the user's words, and the turn continues", async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Bash amend',
      scenario: {
        processes: [
          {
            turns: [
              promptTurn(
                { tool_name: 'Bash', input: BUILD, tool_use_id: 'toolu_build' },
                { ...builds, deny: reply('Using pnpm instead.') }
              )
            ]
          }
        ]
      }
    })
    await t.send('build it')
    await expect(t.panel.getByText('Bash command')).toBeVisible()
    await t.page.keyboard.press('Tab')
    const field = t.panel.getByRole('textbox', {
      name: 'No, and tell Claude what to do differently'
    })
    await field.fill('use pnpm')
    await field.press('Enter')

    await expect(t.panel.getByText('Using pnpm instead.')).toBeVisible()
    const decision = (await t.run(0)).decisions()[0]
    expect(decision).toMatchObject({
      behavior: 'deny',
      reply: {
        response: {
          message: expect.stringContaining('To tell you how to proceed, the user said:\nuse pnpm')
        }
      }
    })
    expect((decision.reply as { response: Record<string, unknown> }).response).not.toHaveProperty(
      'interrupt'
    )
    await expect(t.panel.getByText('Rejected · use pnpm')).toBeVisible()
  })

  test('Ask before edits, end to end: the Edit card shows the edit; "switch to accept edits" flips the mode', async ({
    chat
  }) => {
    const EDIT = {
      file_path: '{{cwd}}/f1.txt',
      old_string: 'color = red',
      new_string: 'color = blue',
      replace_all: false
    }
    const t = await chat.openTask({
      title: 'Edit accept edits',
      scenario: {
        processes: [
          {
            turns: [
              promptTurn(
                {
                  tool_name: 'Edit',
                  input: EDIT,
                  tool_use_id: 'toolu_edit',
                  description: 'f1.txt',
                  permission_suggestions: [
                    { type: 'setMode', mode: 'acceptEdits', destination: 'session' }
                  ]
                },
                {
                  allow: [
                    step.emit(
                      ev.toolResult({ toolUseId: 'toolu_edit', content: 'edited' }),
                      ev.text('Edited f1.txt.'),
                      ev.result({ text: 'Edited f1.txt.' })
                    )
                  ]
                }
              )
            ]
          }
        ]
      }
    })
    // Pick "Ask before edits": a live mode switch, no respawn.
    await t.panel.getByRole('button', { name: 'Agent mode: Auto-accept edits' }).click()
    await t.page.getByRole('menuitem', { name: /Ask before edits/ }).click()
    await expect(
      t.panel.getByRole('button', { name: 'Agent mode: Ask before edits' })
    ).toBeVisible()
    await expect
      .poll(async () => (await t.run(0)).controlRequests())
      .toContainEqual({
        subtype: 'set_permission_mode',
        mode: 'default'
      })

    await t.send('make it blue')
    await expect(t.panel.getByText('Edit file')).toBeVisible()
    await expect(t.panel.getByText('Do you want to make this edit to f1.txt?')).toBeVisible()
    await expect(t.panel.getByText('color = red').first()).toBeVisible()
    await expect(t.panel.getByText('color = blue').first()).toBeVisible()
    await t.panel
      .getByRole('button', {
        name: 'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)'
      })
      .click()

    await expect(t.panel.getByText('Edited f1.txt.')).toBeVisible()
    await expect(
      t.panel.getByRole('button', { name: 'Agent mode: Auto-accept edits' })
    ).toBeVisible()
    const run = await t.run(0)
    expect(run.decisions()[0]).toMatchObject({
      toolName: 'Edit',
      behavior: 'allow',
      reply: {
        response: {
          updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
        }
      }
    })
    expect(t.epoch.runs()).toHaveLength(1)
  })

  test('WebFetch: the domain row, and its No asks what to do differently', async ({ chat }) => {
    const FETCH = { url: 'https://example.com/?n=1', prompt: 'What is the title?' }
    const t = await chat.openTask({
      title: 'WebFetch',
      scenario: {
        processes: [
          {
            turns: [
              promptTurn(
                {
                  tool_name: 'WebFetch',
                  input: FETCH,
                  tool_use_id: 'toolu_fetch',
                  description: FETCH.url,
                  permission_suggestions: [
                    {
                      type: 'addRules',
                      destination: 'localSettings',
                      rules: [{ toolName: 'WebFetch', ruleContent: 'domain:example.com' }],
                      behavior: 'allow'
                    }
                  ]
                },
                { allow: reply('Fetched.'), deny: reply('Skipping the fetch.') }
              )
            ]
          }
        ]
      }
    })
    await t.send('fetch it')
    await expect(t.panel.getByText('Claude wants to fetch content from example.com')).toBeVisible()
    await expect(
      t.panel.getByRole('button', { name: "Yes, and don't ask again for example.com" })
    ).toBeVisible()
    await t.panel
      .getByRole('button', { name: 'No, and tell Claude what to do differently (esc)' })
      .click()
    const field = t.panel.getByRole('textbox', {
      name: 'No, and tell Claude what to do differently'
    })
    await field.fill('use the cached copy')
    await field.press('Enter')
    await expect(t.panel.getByText('Skipping the fetch.')).toBeVisible()
    expect((await t.run(0)).decisions()[0]).toMatchObject({
      toolName: 'WebFetch',
      behavior: 'deny'
    })
  })

  test('MCP tool: server — tool name, answered like any tool', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'MCP',
      scenario: {
        processes: [
          {
            turns: [
              promptTurn(
                {
                  tool_name: 'mcp__spike__echo',
                  input: { text: 'abc1' },
                  tool_use_id: 'toolu_mcp',
                  display_name: 'Echo',
                  mcp_server: { name: 'spike', source: 'dynamic' },
                  permission_suggestions: [
                    {
                      type: 'addRules',
                      rules: [{ toolName: 'mcp__spike__echo' }],
                      behavior: 'allow',
                      destination: 'localSettings'
                    }
                  ]
                },
                { allow: reply('ABC1'), deny: reply('No echo.') }
              )
            ]
          }
        ]
      }
    })
    await t.send('echo abc1')
    await expect(t.panel.getByText('spike — Echo Tool: (MCP)')).toBeVisible()
    await t.panel.getByRole('button', { name: /^Yes$/ }).click()
    await expect(t.panel.getByText('ABC1', { exact: true })).toBeVisible()
    expect((await t.run(0)).decisions()[0]).toMatchObject({
      toolName: 'mcp__spike__echo',
      behavior: 'allow'
    })
  })
})
