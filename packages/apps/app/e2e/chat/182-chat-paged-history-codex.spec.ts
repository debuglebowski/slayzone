/**
 * Paged chat history (chat F), Codex: a 100,000-event Codex chat session opens
 * from the hub's projection holding only its newest rows, reaches its first
 * turn and a needle far up by loading their pages, and a live Codex turn on
 * top of the paged state lands as it would on a full one. Session data:
 * @slayzone/test-utils/chat-long-session (`provider: 'codex'`); the agent is the
 * scripted fake `codex app-server` (fixtures/chat-codex.ts).
 */
import type { Page } from '@playwright/test'
import { resetApp } from '../fixtures/electron'
import { codexReply, expect, test } from '../fixtures/chat-codex'
import {
  CODEX_FIRST as FIRST,
  CODEX_LAST as LAST,
  CODEX_NEEDLE as NEEDLE,
  CODEX_THREAD as THREAD,
  codexLongSessionEvents
} from '../fixtures/chat-long-session'

const EVENTS = 100_000
const PAGE_ROWS = 256
function rowsHeld(page: Page): Promise<{ loaded: number; total: number }> {
  return page.evaluate(() => {
    const panel = Array.from(document.querySelectorAll<HTMLElement>('[data-chat-panel]')).find(
      (p) => p.offsetParent !== null
    )
    const scroller = panel?.querySelector<HTMLElement>('[data-testid="chat-timeline-scroller"]')
    return {
      loaded: Number(scroller?.dataset.rowsLoaded ?? -1),
      total: Number(scroller?.dataset.rowsTotal ?? -1)
    }
  })
}

test.describe('Codex chat: paged history (100,000 events)', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('opens with only its newest rows; first turn, search far up, then a live turn on the paged state', async ({
    codexChat
  }) => {
    test.setTimeout(240_000)
    const t = await codexChat.openTask({
      title: 'Codex paged',
      // The session's own thread (the generated turn-init's): the live turn
      // resumes it, as a reopened tab does.
      conversationId: THREAD,
      spawn: 'on-send',
      seedEvents: codexLongSessionEvents(EVENTS),
      scenario: {
        threads: [THREAD],
        processes: [{ turns: [codexReply('live answer on the paged state')] }]
      }
    })
    const timeline = t.panel.getByTestId('chat-timeline-scroller')
    await expect(timeline.getByText(LAST)).toBeVisible({ timeout: 60_000 })
    const held = await rowsHeld(t.page)
    expect(held.total).toBeGreaterThan(40_000)
    expect(held.loaded).toBeLessThan(2 * PAGE_ROWS)

    await t.composer.focus()
    await t.page.keyboard.press('Meta+ArrowUp')
    await expect(timeline.getByText(FIRST)).toBeVisible({ timeout: 20_000 })
    await t.page.keyboard.press('Meta+ArrowDown')
    await expect(timeline.getByText(LAST)).toBeVisible({ timeout: 20_000 })

    await t.page.keyboard.press('Meta+f')
    const search = t.panel.getByPlaceholder('Find in chat…')
    await search.fill(NEEDLE)
    await expect(t.panel.getByText('1/2')).toBeVisible({ timeout: 20_000 })
    await expect(timeline.getByText(`${NEEDLE} the first one`)).toBeVisible({ timeout: 20_000 })
    await search.press('Escape')

    // A live turn on top of the paged state.
    await t.page.keyboard.press('Meta+ArrowDown')
    await t.send('one more question')
    await expect(timeline.getByText('live answer on the paged state')).toBeVisible({
      timeout: 30_000
    })
    expect((await rowsHeld(t.page)).total).toBeGreaterThan(held.total)
  })
})
