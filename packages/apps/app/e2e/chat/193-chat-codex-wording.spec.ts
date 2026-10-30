/**
 * A Codex tab names Codex, never Claude: the empty chat, the composer, the
 * app's own slash commands in the `/` menu (`/memory` opens AGENTS.md).
 */
import { resetApp } from '../fixtures/electron'
import { codexEchoTurn, expect, test } from '../fixtures/chat-codex'

test.describe('Codex wording', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('the empty chat, the composer and the / menu name Codex', async ({ codexChat }) => {
    const t = await codexChat.openTask({
      title: 'Codex wording',
      scenario: { processes: [{ defaultTurn: codexEchoTurn() }] }
    })
    await expect(t.panel.getByText('Chat with Codex', { exact: true })).toBeVisible()
    await expect(t.composer).toHaveAttribute('placeholder', 'Ask Codex anything…')

    await t.composer.fill('/')
    const menu = t.page.getByRole('listbox')
    await expect(menu).toBeVisible()
    await expect(menu).toContainText('memory')
    await expect(menu).toContainText("project's instructions file")
    await expect(menu).not.toContainText('Claude Code')
    await expect(menu).not.toContainText('Ask Claude')
    await t.composer.fill('')

    // After a turn the timeline has no "Claude" either.
    await t.send('hi')
    await expect(t.panel.getByText('echo: hi')).toBeVisible()
    await expect(t.panel).not.toContainText('Claude')
  })
})
