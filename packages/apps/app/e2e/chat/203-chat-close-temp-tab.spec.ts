/**
 * Closing a temporary (scratch) chat task's tab stops its agent — the chat runs
 * on the computer, so the hub's own session maps alone never reach it. The task
 * itself is kept (reopened from the scratch-terminal list or ⌘⇧T).
 */
import { resetApp } from '../fixtures/electron'
import { echoTurn, expect, test } from '../fixtures/chat'

test.describe('Close a temporary chat task tab', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('stops its computer-owned agent and keeps the task', async ({ chat, electronApp }) => {
    const t = await chat.openTask({
      title: 'Scratch chat',
      isTemporary: true,
      scenario: { processes: [{ defaultTurn: echoTurn() }] }
    })
    await t.send('hello')
    await expect(t.panel.getByText('echo: hello')).toBeVisible()
    const run = await t.run(0)
    expect(run.exit()).toBeUndefined()

    // The real Window → Close Task menu item — the same close path ⌘W takes.
    await electronApp.evaluate(({ Menu }) => {
      const window = Menu.getApplicationMenu()?.items.find((i) => i.label === 'Window')
      const item = window?.submenu?.items.find((i) => i.label === 'Close Task')
      if (!item) throw new Error('Menu item not found: Window → Close Task')
      item.click(undefined as never, undefined as never, undefined as never)
    })

    await t.run(0, (r) => r.exit() !== undefined)
    const kept = await t.page.evaluate(
      (id) => window.getTrpcVanillaClient().task.get.query({ id }),
      t.taskId
    )
    expect(kept?.deleted_at ?? null).toBeNull()
  })
})
