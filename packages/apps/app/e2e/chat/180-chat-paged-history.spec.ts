/**
 * Paged chat history (chat F): a 100,000-event Claude Code session opens from
 * the hub's timeline projection — the renderer holds only the newest rows, the
 * rest load by page when scrolled to, searched, or jumped to — and holds a
 * bounded number of them however far the user goes.
 *
 * Structural checks (rows held, what shows where); the wall-clock budget of the
 * same session is e2e/perf/chat-long-session.spec.ts. Session data:
 * @slayzone/test-utils/chat-long-session.
 */
import type { Page } from '@playwright/test'
import { resetApp } from '../fixtures/electron'
import { expect, test, type ChatHarness } from '../fixtures/chat'
import { FIRST_PROMPT, LAST_REPLY, NEEDLE, longSessionEvents } from '../fixtures/chat-long-session'

const EVENTS = 100_000
/** Rows a page of the projection holds (`TIMELINE_PAGE_ROWS`). */
const PAGE_ROWS = 256
/** Pages the renderer keeps loaded besides the tail, at most (`MAX_LOADED_PAGES`). */
const MAX_LOADED_PAGES = 24

/** Rows the visible timeline holds, and how many the history has. */
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

function mountedRows(page: Page): Promise<number> {
  return page.evaluate(() => {
    const panel = Array.from(document.querySelectorAll<HTMLElement>('[data-chat-panel]')).find(
      (p) => p.offsetParent !== null
    )
    return panel?.querySelectorAll('[data-virtual-list] > [data-index]').length ?? -1
  })
}

async function openPaged(chat: ChatHarness, title: string) {
  const t = await chat.openTask({
    title,
    spawn: 'on-send',
    seedEvents: longSessionEvents(EVENTS),
    scenario: { processes: [] }
  })
  await expect(t.panel.getByText(LAST_REPLY)).toBeVisible({ timeout: 60_000 })
  return t
}

test.describe('Claude chat: paged history (100,000 events)', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('opens from the projection with only its newest rows; the first turn and back; search reaches unloaded pages; rows held stay bounded', async ({
    chat
  }) => {
    test.setTimeout(240_000)
    const t = await openPaged(chat, 'Paged open')

    // Opened paged: the hub's projection, not a replay of every event.
    const opened = await t.page.evaluate(
      (tabId) =>
        window
          .getTrpcVanillaClient()
          .chat.openTimeline.query({ tabId, version: '0.0' })
          .then((r) => r.kind),
      t.tabId
    )
    expect(opened).toBe('full') // another reducer version: never paged
    const held = await rowsHeld(t.page)
    expect(held.total).toBeGreaterThan(60_000)
    expect(held.loaded).toBeLessThan(2 * PAGE_ROWS)
    expect(await mountedRows(t.page)).toBeLessThanOrEqual(80)

    // Cmd+↑: the first turn's page loads; the end is still there.
    await t.composer.focus()
    await t.page.keyboard.press('Meta+ArrowUp')
    await expect(t.panel.getByText(FIRST_PROMPT)).toBeVisible({ timeout: 20_000 })
    await expect(t.panel.getByText(LAST_REPLY)).toHaveCount(0)
    expect((await rowsHeld(t.page)).loaded).toBeLessThan(6 * PAGE_ROWS)
    await t.page.keyboard.press('Meta+ArrowDown')
    await expect(t.panel.getByText(LAST_REPLY)).toBeVisible({ timeout: 20_000 })

    // Cmd+F: both needles (turns 3 and 600, pages far apart), counted and reached.
    await t.page.keyboard.press('Meta+f')
    const search = t.panel.getByPlaceholder('Find in chat…')
    await search.fill(NEEDLE)
    await expect(t.panel.getByText('1/2')).toBeVisible({ timeout: 20_000 })
    await expect(t.panel.getByText(`${NEEDLE} the first one`)).toBeVisible({ timeout: 20_000 })
    await search.press('Enter')
    await expect(t.panel.getByText('2/2')).toBeVisible()
    await expect(t.panel.getByText(`${NEEDLE} the second one`)).toBeVisible({ timeout: 20_000 })
    await search.press('Escape')

    // Scrolling up through a long stretch: pages load ahead of the view, and
    // the renderer keeps at most its budget of them.
    const scroller = t.panel.getByTestId('chat-timeline-scroller')
    await t.page.keyboard.press('Meta+ArrowDown')
    await expect(t.panel.getByText(LAST_REPLY)).toBeVisible({ timeout: 20_000 })
    await scroller.hover()
    for (let i = 0; i < 120; i++) {
      await t.page.mouse.wheel(0, -4_000)
      await t.page.waitForTimeout(40)
    }
    await expect
      .poll(async () => (await rowsHeld(t.page)).loaded, { timeout: 20_000 })
      .toBeGreaterThan(3 * PAGE_ROWS)
    expect((await rowsHeld(t.page)).loaded).toBeLessThanOrEqual((MAX_LOADED_PAGES + 2) * PAGE_ROWS)
    expect(await mountedRows(t.page)).toBeLessThanOrEqual(80)
    // No placeholder stays where the view is (what is shown is loaded).
    await expect.poll(() => mountedRows(t.page), { timeout: 20_000 }).toBeGreaterThan(3)
  })
})
