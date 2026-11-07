/**
 * Claude Code chat: keyboard flow (chat E, plan 4.6).
 * - Esc Esc with no turn running and an empty composer opens the message list
 *   (the TUI's double-Esc → rewind); picking a message edits & resends it.
 *   With text in the composer it clears the draft;
 *   while a turn runs Esc stops it and never rewinds.
 * - Cmd+K (the app's palette) has the chat's own page: Compact runs /compact
 *   without touching the draft; Model… switches the model.
 * - Cmd+I / Cmd+Shift+I insert the task title / description into the composer
 *   at the caret (parity with the PTY terminal), without sending.
 * Against the scripted fake CLI.
 */
import type { Locator } from '@playwright/test'
import { resetApp } from '../fixtures/electron'
import { pressShortcut } from '../fixtures/shortcuts'
import { echoTurn, ev, expect, step, test } from '../fixtures/chat'

test.describe('Chat keyboard', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  // The double-Esc window is 800 ms (useChatPanelKeyboard DOUBLE_ESC_MS; its hook
  // tests pin the boundary with a fake clock). Two separate Playwright key calls
  // race that window on a loaded box, so each pair is dispatched in ONE renderer
  // turn (`escs`). Each Esc's `defaultPrevented` says what it did: the hook
  // prevents the Esc that acts (clear / rewind / stop), never the one that arms.

  test('Esc Esc with text in the composer clears the draft (first Esc keeps it)', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Esc Esc draft',
      scenario: { processes: [{ defaultTurn: echoTurn() }] }
    })
    await t.send('one')
    await expect(t.panel.getByText('echo: one')).toBeVisible()
    await expect(t.stopButton).toBeHidden()
    const items = t.page.getByTestId('rewind-picker-item')

    await t.composer.fill('keep me')
    const pair = await escs(t.composer, 2)
    // The first Esc keeps the text (it only arms); the second clears it.
    expect(pair.valueAfterFirst).toBe('keep me')
    expect(pair.prevented).toEqual([false, true])
    await expect(t.composer).toHaveValue('')
    await expect(items).toHaveCount(0)
  })

  test('Esc Esc idle + empty composer opens rewind; Enter edits & resends', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Esc Esc rewind',
      scenario: { processes: [{ turns: [echoTurn(), echoTurn()], defaultTurn: echoTurn() }] }
    })
    await t.send('one')
    await expect(t.panel.getByText('echo: one')).toBeVisible()
    await t.send('two')
    await expect(t.panel.getByText('echo: two')).toBeVisible()
    await expect(t.stopButton).toBeHidden()
    const items = t.page.getByTestId('rewind-picker-item')

    // Empty and idle: the message list, newest first; Enter edits & resends it.
    await t.composer.fill('')
    expect((await escs(t.composer, 2)).prevented).toEqual([false, true])
    await expect(items).toHaveCount(2)
    await expect(items.first()).toContainText('two')
    await t.page.keyboard.press('Enter')
    const dialog = t.page.getByTestId('rewind-dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByTestId('rewind-confirm').click()
    await expect(dialog).toBeHidden()
    await expect(t.composer).toHaveValue('two')
    const run = await t.run(0, (r) => r.rewound().length === 1)
    expect(run.rewound()).toHaveLength(1)
  })

  test('a turn running: Esc stops it; the next Esc does not rewind', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Esc stops',
      scenario: {
        processes: [
          {
            // Stays running until Stop.
            turns: [[step.emit(ev.init(), ev.text('working…')), step.hang()]],
            defaultTurn: echoTurn()
          }
        ]
      }
    })
    const items = t.page.getByTestId('rewind-picker-item')
    await t.send('long one')
    await expect(t.panel.getByText('working…')).toBeVisible()
    await expect(t.stopButton).toBeVisible()
    // The Esc that stops the turn acts (prevented)…
    expect((await escs(t.composer, 1)).prevented).toEqual([true])
    await expect(t.stopButton).toBeHidden()
    // Idle for real: while the stop lands the button reads "Stopping" (still in
    // flight, so an Esc would stop again); the Send button is back once it ended.
    await expect(t.sendButton).toBeVisible()
    // …and does not arm: the first Esc once idle only arms, it never rewinds.
    expect((await escs(t.composer, 1)).prevented).toEqual([false])
    await expect(items).toHaveCount(0)
  })

  test('Cmd+K → Chat…: Compact keeps the draft; Model… switches the model', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Chat palette',
      scenario: { processes: [{ defaultTurn: echoTurn() }] }
    })
    await t.send('hello')
    await expect(t.panel.getByText('echo: hello')).toBeVisible()
    await t.composer.fill('my draft')

    const palette = t.page.locator('[cmdk-root]')
    const row = (text: string) => palette.locator('[cmdk-item]').filter({ hasText: text })
    const openChatPage = async () => {
      await pressShortcut(t.page, 'search')
      await expect(palette.locator('[cmdk-input]')).toBeFocused()
      await row('Chat…').click()
    }

    await openChatPage()
    await row('Compact conversation').click()
    await expect(palette).toHaveCount(0)
    const run = await t.run(0, (r) => r.userMessages().includes('/compact'))
    expect(run.userMessages()).toContain('/compact')
    await expect(t.composer).toHaveValue('my draft')

    await openChatPage()
    await row('Model…').click()
    await row('Sonnet').click()
    const switched = await t.run(0, (r) => r.controlRequests('set_model').length > 0)
    expect(switched.controlRequests()).toContainEqual({ subtype: 'set_model', model: 'sonnet' })
  })

  test('Cmd+I / Cmd+Shift+I insert title / description into the composer', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Inject me',
      description: 'Fix **the** bug',
      scenario: { processes: [{ defaultTurn: echoTurn() }] }
    })
    await t.composer.fill('a  b')
    // Caret between the two spaces: inserted there, not appended.
    await t.composer.evaluate((el: HTMLTextAreaElement) => {
      el.focus()
      el.setSelectionRange(2, 2)
    })
    await pressShortcut(t.page, 'terminal-inject-desc')
    await expect(t.composer).toHaveValue('a Fix the bug b')
    await pressShortcut(t.page, 'terminal-inject-title')
    await expect(t.composer).toHaveValue('a Fix the bugInject me b')
    await expect(t.composer).toBeFocused()
    // Inserted, never sent.
    const run = await t.run(0)
    expect(run.userMessages()).toHaveLength(0)
  })
})

/**
 * `n` Esc keydowns on the composer, dispatched back to back in one renderer turn
 * (one macrotask between them, so React commits the first one's update), from the
 * focused composer like a real press. Returns each event's `defaultPrevented` and
 * the composer's value after the first.
 */
async function escs(
  composer: Locator,
  n: number
): Promise<{ prevented: boolean[]; valueAfterFirst: string }> {
  return composer.evaluate(async (el: HTMLTextAreaElement, count) => {
    el.focus()
    const prevented: boolean[] = []
    let valueAfterFirst = ''
    for (let i = 0; i < count; i++) {
      const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      el.dispatchEvent(e)
      prevented.push(e.defaultPrevented)
      await new Promise((r) => setTimeout(r, 0))
      if (i === 0) valueAfterFirst = el.value
    }
    return { prevented, valueAfterFirst }
  }, n)
}
