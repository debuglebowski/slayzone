/**
 * ⌘⇧D (Complete & Close Tab) on a regular chat task stops its agent. A done task
 * keeps no agent: completion stops chats too, the computer-owned process
 * included — not only PTYs.
 */
import { resetApp } from '../fixtures/electron'
import { pressShortcut } from '../fixtures/shortcuts'
import { echoTurn, expect, test } from '../fixtures/chat'

test.describe('Complete & Close Tab on a chat task', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('stops its computer-owned agent and marks the task done', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Complete chat',
      scenario: { processes: [{ defaultTurn: echoTurn() }] }
    })
    await t.send('hello')
    await expect(t.panel.getByText('echo: hello')).toBeVisible()
    const run = await t.run(0)
    expect(run.exit()).toBeUndefined()

    await pressShortcut(t.page, 'complete-close-tab')
    const dialog = t.page.locator('[data-slot="alert-dialog-content"]')
    await expect(dialog.getByText('Mark as complete and close tab?')).toBeVisible()
    await dialog.getByRole('button', { name: 'Complete' }).click()

    await t.run(0, (r) => r.exit() !== undefined)
    const task = await t.page.evaluate(
      (id) => window.getTrpcVanillaClient().task.get.query({ id }),
      t.taskId
    )
    expect(task?.status).toBe('done')
  })
})
