/**
 * Claude Code chat: the "Up next" queue is editable and reorderable (plan 4.2).
 * Editing a queued message HOLDS it: if the running turn ends meanwhile, the
 * old text is not sent — the queue waits until the edit is saved (or
 * cancelled). Edits and moves change exactly what the CLI receives.
 * Harness + scenario API: fixtures/chat.ts, packages/shared/test-utils/fake-claude/README.md.
 */
import { resetApp } from '../fixtures/electron'
import { echoTurn, expect, reply, step, test, type ChatTask } from '../fixtures/chat'

/** First turn runs `ms`, every later one echoes. */
const scenario = (ms: number) => ({
  processes: [{ turns: [[step.sleep(ms), ...reply('first done')]], defaultTurn: echoTurn() }]
})

async function queue(t: ChatTask, text: string): Promise<void> {
  await t.send(text)
  await expect(t.panel.getByTestId('chat-queue-item').filter({ hasText: text })).toBeVisible()
}

test.describe('Claude chat: editable, reorderable queue', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('an edited queued message reaches the CLI as edited', async ({ chat }) => {
    const t = await chat.openTask({ title: 'Queue edit', scenario: scenario(4_000) })
    await t.send('first')
    await expect(t.stopButton).toBeVisible()
    await queue(t, 'second')
    await t.panel.getByRole('button', { name: 'Edit queued message' }).click()
    const editor = t.panel.getByRole('textbox', { name: 'Edit queued message' })
    await editor.fill('second, edited')
    await editor.press('Enter')
    await expect(
      t.panel.getByTestId('chat-queue-item').filter({ hasText: 'second, edited' })
    ).toBeVisible()
    await expect(t.panel.getByText('echo: second, edited')).toBeVisible({ timeout: 15_000 })
    const run = await t.run(0, (r) => r.userMessages().length === 2)
    expect(run.userMessages()).toEqual(['first', 'second, edited'])
  })

  test('reordering changes the order the CLI receives them in', async ({ chat }) => {
    const t = await chat.openTask({ title: 'Queue reorder', scenario: scenario(4_000) })
    await t.send('first')
    await expect(t.stopButton).toBeVisible()
    await queue(t, 'alpha')
    await queue(t, 'beta')
    const alpha = t.panel.getByTestId('chat-queue-item').filter({ hasText: 'alpha' })
    await alpha.focus()
    await alpha.press('Alt+ArrowDown')
    await expect(t.panel.getByTestId('chat-queue-item').first()).toContainText('beta')
    const run = await t.run(0, (r) => r.userMessages().length === 3, 20_000)
    expect(run.userMessages()).toEqual(['first', 'beta', 'alpha'])
  })

  test('a turn that ends while a queued message is edited does not send the old text', async ({
    chat
  }) => {
    const t = await chat.openTask({ title: 'Queue hold', scenario: scenario(1_500) })
    await t.send('first')
    await expect(t.stopButton).toBeVisible()
    await queue(t, 'draft words')
    await t.panel.getByRole('button', { name: 'Edit queued message' }).click()
    const editor = t.panel.getByRole('textbox', { name: 'Edit queued message' })
    await expect(editor).toBeVisible()
    // The first turn ends while the editor is open: nothing goes out.
    await expect(t.panel.getByText('first done')).toBeVisible()
    await t.page.waitForTimeout(1_500)
    expect((await t.run(0)).userMessages()).toEqual(['first'])
    await editor.fill('final words')
    await editor.press('Enter')
    const run = await t.run(0, (r) => r.userMessages().length === 2)
    expect(run.userMessages()).toEqual(['first', 'final words'])
  })

  test('"Send now" stops the running turn and that message goes next; the rest keep their order', async ({
    chat
  }) => {
    const t = await chat.openTask({ title: 'Queue send now', scenario: scenario(30_000) })
    await t.send('first')
    await expect(t.stopButton).toBeVisible()
    await queue(t, 'later')
    await queue(t, 'urgent')
    await t.panel
      .getByTestId('chat-queue-item')
      .filter({ hasText: 'urgent' })
      .getByRole('button', { name: 'Send now' })
      .click()
    await expect(t.panel.getByText('echo: urgent')).toBeVisible({ timeout: 15_000 })
    const run = await t.run(0, (r) => r.userMessages().length === 3, 20_000)
    expect(run.userMessages()).toEqual(['first', 'urgent', 'later'])
    // A live interrupt: the same process, one interrupt request.
    expect(run.controlRequests('interrupt')).toHaveLength(1)
  })
})
