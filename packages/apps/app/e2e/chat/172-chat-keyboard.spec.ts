/**
 * Claude Code chat: keyboard flow (chat E, plan 4.6).
 * - Esc Esc with no turn running and an empty composer opens the message list
 *   (the TUI's double-Esc → rewind); picking a message edits & resends it.
 *   With text in the composer it does nothing (typed text is never lost);
 *   while a turn runs Esc stops it and never rewinds.
 * - Cmd+K (the app's palette) has the chat's own page: Compact runs /compact
 *   without touching the draft; Model… switches the model.
 * Against the scripted fake CLI.
 */
import { resetApp } from '../fixtures/electron'
import { pressShortcut } from '../fixtures/shortcuts'
import { echoTurn, ev, expect, step, test } from '../fixtures/chat'

test.describe('Chat keyboard', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('Esc Esc opens rewind: idle + empty composer only', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Esc Esc',
      scenario: {
        processes: [
          {
            turns: [
              echoTurn(),
              echoTurn(),
              // Stays running until Stop.
              [step.emit(ev.init(), ev.text('working…')), step.hang()]
            ],
            defaultTurn: echoTurn()
          }
        ]
      }
    })
    await t.send('one')
    await expect(t.panel.getByText('echo: one')).toBeVisible()
    await t.send('two')
    await expect(t.panel.getByText('echo: two')).toBeVisible()
    const items = t.page.getByTestId('rewind-picker-item')

    // Text in the composer: nothing happens, the text stays.
    await t.composer.fill('keep me')
    await t.composer.press('Escape')
    await t.composer.press('Escape')
    await expect(t.composer).toHaveValue('keep me')
    await expect(items).toHaveCount(0)

    // Empty and idle: the message list, newest first; Enter edits & resends it.
    await t.composer.fill('')
    await t.composer.press('Escape')
    await t.composer.press('Escape')
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

    // A turn running: Esc stops it; the second Esc does not rewind.
    await t.composer.fill('')
    await t.send('long one')
    await expect(t.panel.getByText('working…')).toBeVisible()
    await expect(t.stopButton).toBeVisible()
    await t.composer.press('Escape')
    await t.composer.press('Escape')
    await expect(t.stopButton).toBeHidden()
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
})
