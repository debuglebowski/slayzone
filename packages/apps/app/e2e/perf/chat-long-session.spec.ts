/**
 * Render budget of a 10,000-event Claude Code chat session (plan 4.1), and of a
 * 100,000-event one opened paged (chat F), in real Chromium: opening the
 * session's tab, settling at its first turn and back at its end, frame times +
 * mounted rows while scrolling through it fast, and (100k) the renderer's heap.
 * Limits: `render` / `render100k` in
 * task-terminals/src/client/chat/__perf__/budget.json (the reducer's and the
 * hub's own budgets are checked by `pnpm test:chat:perf`). The Codex 100k
 * session: chat-long-session-codex.spec.ts.
 *
 * Wall-clock: run alone on a quiet machine (`pnpm test:e2e:perf`), like
 * boot-budget. The load-independent checks of the same sessions are in the
 * default suite: e2e/chat/165-chat-long-session.spec.ts, 180-184.
 */
import { resetApp } from '../fixtures/electron'
import { expect, test } from '../fixtures/chat'
import {
  FIRST_PROMPT,
  LAST_REPLY,
  answeredLongSessionEvents,
  longSessionEvents
} from '../fixtures/chat-long-session'
import {
  BUDGET,
  BUDGET_100K,
  expectWithin,
  measureLongSession
} from '../fixtures/chat-render-measure'

test.describe('chat long-session render budget', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('a 10,000-event session opens, settles at both ends, and scrolls within budget', async ({
    chat
  }) => {
    test.setTimeout(180_000)
    const t = await chat.openTask({
      title: 'Long session budget',
      spawn: 'on-send',
      seedEvents: longSessionEvents(),
      scenario: { processes: [] }
    })
    await expect(t.panel.getByText(LAST_REPLY)).toBeVisible({ timeout: 30_000 })
    const numbers = await measureLongSession(t.page, t.taskId, {
      first: FIRST_PROMPT,
      last: LAST_REPLY
    })
    console.log(`[chat-long-session] ${JSON.stringify(numbers)} budget ${JSON.stringify(BUDGET)}`)
    expectWithin(numbers, BUDGET)
  })

  test('a 100,000-event session opens paged, settles at both ends, and scrolls within budget', async ({
    chat
  }) => {
    test.setTimeout(300_000)
    const t = await chat.openTask({
      title: 'Long session budget 100k',
      spawn: 'on-send',
      seedEvents: answeredLongSessionEvents(BUDGET_100K.events),
      scenario: { processes: [] }
    })
    await expect(t.panel.getByText(LAST_REPLY)).toBeVisible({ timeout: 60_000 })
    const numbers = await measureLongSession(t.page, t.taskId, {
      first: FIRST_PROMPT,
      last: LAST_REPLY
    })
    console.log(
      `[chat-long-session 100k] ${JSON.stringify(numbers)} budget ${JSON.stringify(BUDGET_100K)}`
    )
    expectWithin(numbers, BUDGET_100K)
  })
})
