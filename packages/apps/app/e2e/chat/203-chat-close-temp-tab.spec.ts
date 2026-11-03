/**
 * Closing a temporary (scratch) chat task's tab stops its agent — the chat runs
 * on the computer, so the hub's own session maps alone never reach it. The task
 * itself is kept (reopened from the scratch-terminal list or ⌘⇧T).
 */
import { resetApp } from '../fixtures/electron'
import { echoTurn, expect, step, test } from '../fixtures/chat'

test.describe('Close a temporary chat task tab', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('stops its computer-owned agent and keeps the task', async ({ chat, electronApp }) => {
    const t = await chat.openTask({
      title: 'Scratch chat',
      isTemporary: true,
      // Like the real CLI (~0.8 s), it takes its time to exit on SIGTERM (under
      // the host's 2 s SIGKILL, so it still logs its own exit).
      scenario: { processes: [{ defaultTurn: echoTurn(), onSigterm: [step.sleep(1_200)] }] }
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

    // Shown stopped at once — not after the CLI's own shutdown.
    const state = () =>
      t.page.evaluate(
        (sid) =>
          (
            window as unknown as {
              __slayzone_terminalStateStore: {
                getState: () => { byId: Record<string, string> }
              }
            }
          ).__slayzone_terminalStateStore.getState().byId[sid],
        `${t.taskId}:${t.tabId}`
      )
    await expect.poll(state, { timeout: 900, intervals: [50] }).toBe('dead')
    expect(run.exit()).toBeUndefined()

    await t.run(0, (r) => r.exit() !== undefined)
    expect(await state()).toBe('dead')
    const kept = await t.page.evaluate(
      (id) => window.getTrpcVanillaClient().task.get.query({ id }),
      t.taskId
    )
    expect(kept?.deleted_at ?? null).toBeNull()
  })
})
