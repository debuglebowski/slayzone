/**
 * Claude Code chat: pinned messages. A user message and an answer pin from
 * their rows; the pins survive a reload; the composer footer lists them and
 * picking one scrolls the timeline back to it; Cmd+K lists them too; × unpins.
 * Harness: fixtures/chat.ts.
 */
import { resetApp } from '../fixtures/electron'
import { pressShortcut } from '../fixtures/shortcuts'
import { echoTurn, expect, test } from '../fixtures/chat'

test.describe('Claude chat: pinned messages', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('pin a message and an answer, reload, go back to them, unpin', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Pinned messages',
      // One script per turn: each answer gets its own message id, as the CLI's do.
      scenario: { processes: [{ turns: [echoTurn(), echoTurn()] }] }
    })
    await t.send('first question')
    const answer = t.panel
      .getByTestId('chat-assistant-answer')
      .filter({ hasText: 'echo: first question' })
    await expect(answer).toBeVisible()

    // Pin the answer from its toolbar: its mark stays once the toolbar hides.
    await answer.hover()
    await answer
      .getByRole('toolbar', { name: 'Answer actions' })
      .getByRole('button', { name: 'Pin message', exact: true })
      .click()
    const footer = t.panel.getByTestId('chat-pinned-messages')
    await expect(footer).toHaveAccessibleName('Pinned messages (1)')
    await t.composer.hover()
    await expect(answer.getByTestId('chat-pinned-mark')).toBeVisible()

    // Pin the user message from its row.
    const userRow = t.panel
      .locator('[data-anchor-key^="user:"]')
      .filter({ hasText: 'first question' })
      .first()
    await userRow.hover()
    await userRow.getByRole('button', { name: 'Pin message', exact: true }).click()
    await expect(footer).toHaveAccessibleName('Pinned messages (2)')

    // A long second turn pushes the first one out of view.
    const long = Array.from({ length: 80 }, (_, i) => `filler line ${i}`).join('\n')
    await t.send(long)
    await expect(t.panel.getByText('filler line 79').last()).toBeVisible()
    await expect(answer).not.toBeInViewport()

    // Durable: a reload lists both, newest first.
    await t.reload()
    await expect(footer).toHaveAccessibleName('Pinned messages (2)')
    await footer.click()
    const items = t.page.getByTestId('chat-pinned-message')
    await expect(items).toHaveCount(2)
    await expect(items.nth(0)).toContainText('first question')
    await expect(items.nth(1)).toContainText('echo: first question')

    // Go to the answer: the timeline scrolls back to it.
    const pinnedAnswer = t.panel
      .getByTestId('chat-assistant-answer')
      .filter({ hasText: 'echo: first question' })
    await expect(pinnedAnswer).not.toBeInViewport()
    await items.nth(1).click()
    await expect(pinnedAnswer).toBeInViewport({ timeout: 5_000 })

    // Cmd+K lists them too.
    const palette = t.page.locator('[cmdk-root]')
    const row = (text: string) => palette.locator('[cmdk-item]').filter({ hasText: text })
    await pressShortcut(t.page, 'search')
    await expect(palette.locator('[cmdk-input]')).toBeFocused()
    await row('Chat…').click()
    await row('Go to pinned message…').click()
    await expect(palette.locator('[cmdk-item]')).toHaveCount(2)
    await t.page.keyboard.press('Escape')
    await expect(palette).toHaveCount(0)

    // × unpins.
    await footer.click()
    await items.nth(0).hover()
    await t.page
      .getByRole('listitem')
      .filter({ hasText: 'first question' })
      .filter({ hasNotText: 'echo' })
      .getByRole('button', { name: 'Unpin message', exact: true })
      .click()
    await expect(footer).toHaveAccessibleName('Pinned messages (1)')
  })
})
