/**
 * Claude Code chat: the `/` menu shows the CLI's own description and argument
 * hint for its commands (plan 3.1 follow-up). The chat sends `initialize` first
 * on every spawn; the reply's `commands[]` carries them. They are stored per
 * project, so the menu has them again after a reload, before any new turn.
 * After Tab parks `/name `, the hint shows as ghost text (TUI parity).
 * Harness + scenario API: fixtures/chat.ts, packages/shared/test-utils/fake-claude/README.md.
 */
import { resetApp } from '../fixtures/electron'
import { echoTurn, expect, test } from '../fixtures/chat'

const COMMANDS = [
  {
    name: 'compact',
    description: 'Free up context by summarizing the conversation',
    argumentHint: '<optional instructions>'
  },
  { name: 'context', description: 'Show current context usage', argumentHint: '' }
]
/** What a previous session left: a turn-init carrying the CLI's command list. */
const SEEDED_INIT = {
  kind: 'turn-init',
  sessionId: 'seeded-hints',
  model: 'claude-haiku-5-5',
  cwd: '/seeded',
  tools: [],
  slashCommands: ['compact', 'context'],
  terminalSlashCommands: [],
  skills: [],
  cliVersion: '2.1.312'
}

test.describe('Claude chat: CLI command descriptions + argument hints', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('the menu shows the CLI description + hint; Tab leaves the hint as ghost text; a reload keeps them', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Command hints',
      seedEvents: [SEEDED_INIT],
      scenario: {
        processes: [
          { controlPayloads: { initialize: { commands: COMMANDS } }, defaultTurn: echoTurn() }
        ]
      }
    })
    // initialize went out first, before anything else the app wrote.
    const run = await t.run(0, (r) => r.stdin().length > 0)
    expect(run.stdin()[0]).toMatchObject({
      type: 'control_request',
      request: { subtype: 'initialize' }
    })

    const menu = t.panel.locator('[role="listbox"][data-source]')
    const compact = menu.locator('[data-source="cli-commands"]', { hasText: '/compact' })
    await t.composer.click()
    await expect(async () => {
      await t.composer.fill('')
      await t.composer.fill('/comp')
      await expect(compact).toContainText('Free up context by summarizing the conversation', {
        timeout: 1_000
      })
    }).toPass({ timeout: 15_000 })
    await expect(compact).toContainText('<optional instructions>')
    await t.composer.press('Tab')
    await expect(t.composer).toHaveValue('/compact ')
    await expect(t.panel.getByTestId('chat-argument-hint')).toContainText('<optional instructions>')
    await t.composer.pressSequentially('keep')
    await expect(t.panel.getByTestId('chat-argument-hint')).toHaveCount(0)
    await t.composer.fill('')

    // After a reload the live reply is gone; the stored details are used.
    await t.reload()
    await t.composer.click()
    await t.composer.fill('/comp')
    await expect(
      menu.locator('[data-source="cli-commands"]', { hasText: '/compact' })
    ).toContainText('Free up context by summarizing the conversation')
  })
})
