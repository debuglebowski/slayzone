/**
 * Claude Code chat: custom slash commands (`.claude/commands/*.md`) are run by
 * the CLI. The `/` menu names them the way the CLI does (sub-folders as
 * `dir:name`), with the file's description and argument hint, and the CLI
 * receives exactly what was typed (`/x MANGO 3`), never an expanded template.
 * Harness + scenario API: fixtures/chat.ts, packages/shared/test-utils/fake-claude/README.md.
 */
import { resetApp } from '../fixtures/electron'
import { ev, expect, step, test } from '../fixtures/chat'

const X = `---
description: Echo the arguments
argument-hint: <fruit> <count>
allowed-tools: Bash(echo:*)
---
First argument: $0
All arguments: $ARGUMENTS
Shell output: !\`echo SHELL_OK\`
`
const Z = `---
description: Namespaced spike command
---
Reply with exactly Z_OK
`
const REPO_FILES = { '.claude/commands/x.md': X, '.claude/commands/sub/z.md': Z }

/** The CLI lists the project's commands in every init, namespaced ones as `dir:name`. */
const SLASH_COMMANDS = ['compact', 'x', 'sub:z']
const init = () => ({ ...ev.init(), slash_commands: SLASH_COMMANDS })

/** What a previous session left: a turn-init carrying the CLI's command list. */
const SEEDED_INIT = {
  kind: 'turn-init',
  sessionId: 'seeded-commands',
  model: 'claude-haiku-5-5',
  cwd: '/seeded',
  tools: [],
  slashCommands: SLASH_COMMANDS,
  terminalSlashCommands: [],
  skills: [],
  cliVersion: '2.1.312'
}

test.describe('Claude chat: custom commands run by the CLI', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('the / menu lists custom commands by their CLI name, with description and hint', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Custom commands menu',
      repoFiles: REPO_FILES,
      seedEvents: [SEEDED_INIT],
      spawn: 'on-send',
      scenario: { processes: [] }
    })
    await t.composer.click()
    await t.composer.fill('/')
    const menu = t.panel.locator('[role="listbox"][data-source]')
    const x = menu.locator('[data-source="commands"]', { hasText: '/x' })
    await expect(x).toContainText('<fruit> <count>')
    await expect(x).toContainText('Echo the arguments')
    const z = menu.locator('[data-source="commands"]', { hasText: '/sub:z' })
    await expect(z).toContainText('Namespaced spike command')
    // The file rows replace the CLI's bare entries for the same names.
    await expect(menu.locator('[data-source="cli-commands"]', { hasText: '/sub:z' })).toHaveCount(0)
    await expect(
      menu.locator('[data-source="cli-commands"]', { hasText: '/compact' })
    ).toBeVisible()
    await t.composer.press('Escape')
    await t.composer.fill('')
  })

  test('Tab parks `/name ` for arguments; Enter without them sends nothing', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Custom commands parking',
      repoFiles: REPO_FILES,
      seedEvents: [SEEDED_INIT],
      spawn: 'on-send',
      scenario: { processes: [] }
    })
    const menu = t.panel.locator('[role="listbox"][data-source]')
    await t.composer.click()
    await t.composer.fill('/sub')
    await expect(menu.locator('[data-source="commands"]', { hasText: '/sub:z' })).toBeVisible()
    await t.composer.press('Tab')
    await expect(t.composer).toHaveValue('/sub:z ')
    await t.composer.fill('/x')
    await expect(menu.locator('[data-source="commands"]', { hasText: '/x' })).toBeVisible()
    await t.composer.press('Enter')
    // `x` takes arguments and none were typed: `/x ` waits for them, nothing is sent.
    await expect(t.composer).toHaveValue('/x ')
    const sent = (await t.events()).filter((e) => e.event.kind === 'user-message')
    expect(sent).toEqual([])
    expect(t.epoch.runs()).toHaveLength(0)
    await t.composer.fill('')
  })

  test('the CLI receives the typed `/x MANGO 3`, not an expanded template', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Custom commands send',
      repoFiles: REPO_FILES,
      seedEvents: [SEEDED_INIT],
      scenario: {
        processes: [
          {
            // The real CLI (2.1.312) expands the template itself and answers this.
            turns: [
              [step.emit(init(), ev.text('MANGO|SHELL_OK'), ev.result({ text: 'MANGO|SHELL_OK' }))]
            ]
          }
        ]
      }
    })
    const menu = t.panel.locator('[role="listbox"][data-source]')
    // Pick the command from the menu, then type its arguments.
    await t.composer.click()
    await t.composer.fill('/x')
    await expect(menu.locator('[data-source="commands"]', { hasText: '/x' })).toBeVisible()
    await t.composer.press('Tab')
    await expect(t.composer).toHaveValue('/x ')
    await t.composer.pressSequentially('MANGO 3')
    await t.composer.press('Enter')

    await expect(t.panel.getByText('MANGO|SHELL_OK', { exact: true })).toBeVisible()
    const run = await t.run(0, (r) => r.userMessages().length === 1)
    expect(run.userMessages()).toEqual(['/x MANGO 3'])
    // The chat records what was typed, too.
    const sent = (await t.events()).filter((e) => e.event.kind === 'user-message')
    expect(sent.map((e) => e.event.text)).toEqual(['/x MANGO 3'])
    // ↑ recalls the typed command, not a template.
    await expect
      .poll(
        async () => {
          await t.composer.fill('')
          await t.composer.press('ArrowUp')
          return t.composer.inputValue()
        },
        { timeout: 10_000 }
      )
      .toBe('/x MANGO 3')
    await t.composer.fill('')
  })
})
