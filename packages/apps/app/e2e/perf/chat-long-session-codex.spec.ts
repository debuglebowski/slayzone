/**
 * Render budget of a 100,000-event Codex chat session opened paged (chat F), in
 * real Chromium — the Codex twin of chat-long-session.spec.ts's 100k test:
 * opening the session's tab, settling at its first turn and back at its end,
 * frame times + mounted rows while scrolling through it fast, and the renderer's
 * heap. Limits: `render100k` in task-terminals/src/client/chat/__perf__/budget.json.
 *
 * Wall-clock: run alone on a quiet machine (`pnpm test:e2e:perf`). The
 * load-independent checks: e2e/chat/182-chat-paged-history-codex.spec.ts.
 */
import { resetApp } from '../fixtures/electron'
import { expect, test } from '../fixtures/chat-codex'
import { CODEX_FIRST, CODEX_LAST, codexLongSessionEvents } from '../fixtures/chat-long-session'
import { BUDGET_100K, expectWithin, measureLongSession } from '../fixtures/chat-render-measure'

test.describe('Codex chat long-session render budget', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('a 100,000-event Codex session opens paged, settles at both ends, and scrolls within budget', async ({
    codexChat
  }) => {
    test.setTimeout(300_000)
    const t = await codexChat.openTask({
      title: 'Codex long session budget 100k',
      spawn: 'on-send',
      seedEvents: codexLongSessionEvents(BUDGET_100K.events),
      scenario: { processes: [] }
    })
    await expect(t.panel.getByText(CODEX_LAST)).toBeVisible({ timeout: 60_000 })
    const numbers = await measureLongSession(t.page, t.taskId, {
      first: CODEX_FIRST,
      last: CODEX_LAST
    })
    console.log(
      `[chat-long-session codex 100k] ${JSON.stringify(numbers)} budget ${JSON.stringify(BUDGET_100K)}`
    )
    expectWithin(numbers, BUDGET_100K)
  })
})
