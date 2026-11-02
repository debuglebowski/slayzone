import { resetApp } from '../fixtures/electron'
import { echoTurn, expect, test } from '../fixtures/chat'

test.describe('Answer threads panel width', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('drag resizes, persists across reopen, double-click resets', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Resizable threads',
      scenario: { processes: [{ defaultTurn: echoTurn() }] }
    })
    await t.send('main question')
    const main = t.page.locator('[data-chat-panel]:visible').first()
    const answer = main
      .getByTestId('chat-assistant-answer')
      .filter({ hasText: 'echo: main question' })
    await expect(answer).toBeVisible()
    await answer.hover()
    await answer.getByRole('button', { name: 'Start thread', exact: true }).click()
    const side = t.page.getByRole('complementary', { name: 'Answer threads' })
    const width = async (): Promise<number> => Math.round((await side.boundingBox())!.width)
    expect(await width()).toBe(410)

    const handle = t.page.getByRole('separator', { name: 'Resize threads' })
    const box = (await handle.boundingBox())!
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    await t.page.mouse.move(x, y)
    await t.page.mouse.down()
    await t.page.mouse.move(x - 50, y, { steps: 3 })
    await t.page.mouse.move(x - 100, y, { steps: 3 })
    await t.page.mouse.up()
    expect(await width()).toBe(510)

    // Keyboard: arrows nudge the separator.
    await handle.focus()
    await t.page.keyboard.press('ArrowRight')
    expect(await width()).toBe(494)

    await side.getByRole('button', { name: 'Close threads', exact: true }).click()
    await expect(side).toHaveCount(0)
    await answer.hover()
    await answer.getByRole('button', { name: 'Start thread', exact: true }).click()
    await expect.poll(width).toBe(494)

    await handle.dblclick()
    await expect.poll(width).toBe(410)
  })
})
