/**
 * Paged chat history (chat F): the whole-history features of a 100,000-event
 * session whose older pages are not loaded — the turn outline lists every turn
 * and jumps to the first, the rewind picker offers the first message, the
 * files-changed count and panel cover every file, and "Copy entire
 * conversation" copies all of it (from summaries, or loading what it needs;
 * never a cap). Session data: @slayzone/test-utils/chat-long-session, with the
 * delivery states a real session saves (answered).
 */
import { resetApp } from '../fixtures/electron'
import { expect, test } from '../fixtures/chat'
import { FIRST_PROMPT, LAST_REPLY, answeredLongSessionEvents } from '../fixtures/chat-long-session'

const EVENTS = 100_000

test.describe('Claude chat: paged history — whole-history features (100,000 events)', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('outline, rewind picker, files changed and copy-all cover the whole history', async ({
    chat
  }) => {
    test.setTimeout(240_000)
    const events = answeredLongSessionEvents(EVENTS)
    const turns = events.filter((e) => e.kind === 'user-message').length
    const files = new Set(
      events.flatMap((e) =>
        e.kind === 'tool-call' && e.name === 'Edit'
          ? [String((e.input as { file_path: string }).file_path)]
          : []
      )
    )
    const t = await chat.openTask({
      title: 'Paged features',
      spawn: 'on-send',
      seedEvents: events,
      scenario: { processes: [] }
    })
    await expect(t.panel.getByText(LAST_REPLY)).toBeVisible({ timeout: 60_000 })
    await expect(t.panel.getByTestId('chat-timeline-scroller').getByText(FIRST_PROMPT)).toHaveCount(
      0
    )

    // Turn outline: every turn (the oldest from page summaries); the first one
    // loads and shows when picked.
    await t.panel.getByTestId('chat-turn-outline-toggle').click()
    const outline = t.panel.getByTestId('chat-turn-outline')
    const items = outline.getByTestId('chat-turn-outline-item')
    await expect(items).toHaveCount(turns, { timeout: 20_000 })
    await expect(items.first()).toContainText(FIRST_PROMPT)
    await items.first().click()
    // (In the timeline: the outline lists it too.)
    const timeline = t.panel.getByTestId('chat-timeline-scroller')
    await expect(timeline.getByText(FIRST_PROMPT)).toBeVisible({ timeout: 20_000 })
    await t.panel.getByTestId('chat-turn-outline-toggle').click()

    // Rewind picker (Esc Esc: idle, empty composer): the first message is offered.
    await t.composer.focus()
    await t.page.keyboard.press('Escape')
    await t.page.keyboard.press('Escape')
    const picker = t.page.getByTestId('rewind-picker-input')
    await expect(picker).toBeVisible()
    await picker.fill('FIRST-PROMPT-165')
    await expect(t.page.getByTestId('rewind-picker-item')).toHaveCount(1)
    await t.page.keyboard.press('Escape')

    // Files changed: the count covers every file; the panel lists them all.
    const button = t.panel.getByTestId('chat-files-changed-button')
    await expect(button).toContainText(`${files.size} files`)
    await button.click()
    const panel = t.page.getByTestId('chat-files-panel')
    await expect(panel.getByTestId('chat-files-panel-file')).toHaveCount(files.size, {
      timeout: 30_000
    })
    await button.click()

    // Copy entire conversation: the whole history, first message to last reply.
    await t.page.evaluate(() => {
      const w = window as Window & { __copied?: string }
      navigator.clipboard.writeText = async (text: string) => {
        w.__copied = text
      }
    })
    await timeline.click({ button: 'right' })
    await t.page.getByRole('menuitem', { name: 'Copy entire conversation' }).click()
    await expect
      .poll(
        () => t.page.evaluate(() => (window as Window & { __copied?: string }).__copied ?? ''),
        {
          timeout: 60_000
        }
      )
      .toContain(FIRST_PROMPT)
    const copied = await t.page.evaluate(
      () => (window as Window & { __copied?: string }).__copied ?? ''
    )
    expect(copied).toContain(LAST_REPLY)
  })
})
