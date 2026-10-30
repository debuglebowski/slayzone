/**
 * Codex in the composer footer, against the fake `codex app-server`: the
 * context meter from the token usage Codex reports (percent of its window, no
 * dollars, and no `$0` on the turn), and the model / effort pickers fed by the
 * CLI's own `model/list` (each model with its own effort levels; nothing
 * hardcoded in the UI); Compact from the Cmd+K Chat page and the `/` menu (the
 * `compact` capability). Needs the Codex driver's usage, model and compact
 * handling (X1).
 */
import { resetApp } from '../fixtures/electron'
import { pressShortcut } from '../fixtures/shortcuts'
import { codexEchoTurn, codexReply, cstep, cx, expect, test } from '../fixtures/chat-codex'

const MODEL_LIST = {
  result: {
    data: [
      {
        id: 'gpt-6-luna',
        model: 'gpt-6-luna',
        displayName: 'GPT-6 Luna',
        description: 'Fast and cheap',
        isDefault: true,
        hidden: false,
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: 'Quick' },
          { reasoningEffort: 'medium', description: 'Balanced' },
          { reasoningEffort: 'ultra', description: 'Deepest' }
        ],
        defaultReasoningEffort: 'medium'
      },
      {
        id: 'gpt-6.1-sol',
        model: 'gpt-6.1-sol',
        displayName: 'GPT-6.1 Sol',
        description: 'Bigger',
        isDefault: false,
        hidden: false,
        supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'Deep' }],
        defaultReasoningEffort: 'high'
      }
    ],
    nextCursor: null
  }
}

test.describe('Codex meter and models', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('the context meter shows the share of the window, no dollars anywhere', async ({
    codexChat
  }) => {
    const t = await codexChat.openTask({
      title: 'Codex meter',
      scenario: {
        processes: [
          {
            turns: [
              // The reply reports its own usage; the last update is what counts.
              [...codexReply('Counted.'), cstep.emit(cx.tokenUsage(51_680, 120, 258_400))]
            ]
          }
        ]
      }
    })
    await t.send('count')
    await expect(t.panel.getByText('Counted.')).toBeVisible()
    const meter = t.panel.getByTestId('chat-context-meter')
    // last.totalTokens 51,800 of 258,400 = 20%.
    await expect(meter).toContainText('20%')
    await expect(meter).toContainText('52k/258k')
    await expect(meter).not.toContainText('$')
    await expect(t.panel.getByTestId('chat-turn-cost')).toHaveCount(0)
    // The meter is saved: a reload shows it again.
    await t.reload()
    await expect(t.panel.getByTestId('chat-context-meter')).toContainText('20%')
  })

  test('the pickers offer what model/list returned, each model its own effort levels', async ({
    codexChat
  }) => {
    const t = await codexChat.openTask({
      title: 'Codex pickers',
      scenario: {
        processes: [{ methods: { 'model/list': MODEL_LIST }, defaultTurn: codexEchoTurn() }]
      }
    })
    await t.send('one')
    await expect(t.panel.getByText('echo: one')).toBeVisible()

    const modelPill = t.panel.getByRole('button', { name: /^Chat model:/ })
    await modelPill.click()
    await expect(t.page.getByRole('menuitem', { name: /GPT-6 Luna/ })).toBeVisible()
    await expect(t.page.getByRole('menuitem', { name: /GPT-6\.1 Sol/ })).toBeVisible()
    await expect(t.page.getByRole('menuitem', { name: /GPT-5\.5/ })).toHaveCount(0)
    await t.page.getByRole('menuitem', { name: /GPT-6 Luna/ }).click()
    await expect(t.panel.getByRole('button', { name: 'Chat model: GPT-6 Luna' })).toBeVisible()

    const effortPill = t.panel.getByRole('button', { name: /^Reasoning effort:/ })
    await effortPill.click()
    // The model's own levels (then Codex's Normal / Fast speed rows), not Claude's.
    for (const level of [/^Low/, /^Medium/, /^Ultra/]) {
      await expect(t.page.getByRole('menuitem', { name: level })).toBeVisible()
    }
    for (const level of [/^High/, /^Extra-high/, /^Max/]) {
      await expect(t.page.getByRole('menuitem', { name: level })).toHaveCount(0)
    }
    await t.page.getByRole('menuitem', { name: /Ultra/ }).click()

    await t.send('two')
    await expect(t.panel.getByText('echo: two')).toBeVisible()
    const run = await t.run(0, (r) => r.requests('turn/start').length === 2)
    expect(run.requests('turn/start')[1].params).toMatchObject({
      model: 'gpt-6-luna',
      effort: 'ultra'
    })
  })

  test('Compact: from the Cmd+K Chat page and the / menu', async ({ codexChat }) => {
    const t = await codexChat.openTask({
      title: 'Codex compact',
      scenario: { processes: [{ defaultTurn: codexEchoTurn() }] }
    })
    await t.send('hello')
    await expect(t.panel.getByText('echo: hello')).toBeVisible()

    // The / menu offers it (Codex has no CLI command list of its own).
    await t.composer.fill('/comp')
    const menu = t.page.getByRole('listbox')
    await expect(menu.getByRole('option', { name: /compact/ })).toBeVisible()
    await t.composer.fill('my draft')

    // Cmd+K → Chat… → Compact conversation: the driver compacts the thread.
    const palette = t.page.locator('[cmdk-root]')
    const row = (text: string) => palette.locator('[cmdk-item]').filter({ hasText: text })
    await pressShortcut(t.page, 'search')
    await expect(palette.locator('[cmdk-input]')).toBeFocused()
    await row('Chat…').click()
    await row('Compact conversation').click()
    await expect(palette).toHaveCount(0)
    const run = await t.run(0, (r) => r.requests('thread/compact/start').length > 0)
    expect(run.requests('thread/compact/start')).toHaveLength(1)
    // The draft being written is untouched.
    await expect(t.composer).toHaveValue('my draft')
  })
})
