/**
 * Paged chat history (chat F), recovery: the computer's stored projection is derived
 * from the saved events and safe to throw away.
 * - A stored page that cannot be read: the client opens again from the events
 *   (same content), and the stored projection is thrown away.
 * - A cold conversation with a corrupt checkpoint after hub reconnect: opens paged again,
 *   from a projection rebuilt from the events (same content).
 */
import type { Page } from '@playwright/test'
import { TIMELINE_PROJECTION_VERSION } from '@slayzone/terminal/timeline-checkpoint'
import { resetApp } from '../fixtures/electron'
import { expect, test } from '../fixtures/chat'
import { FIRST_PROMPT, LAST_REPLY, answeredLongSessionEvents } from '../fixtures/chat-long-session'
import { chatProjection } from '../fixtures/chat-seed'

const EVENTS = 20_000

/** The tab's stored checkpoint (null: none). */
async function checkpoint(
  page: Page,
  tabId: string
): Promise<{ version: string; seq: number; data: string } | null> {
  return (await chatProjection(page, tabId)).checkpoint
}

/** Stored as of the tab's newest saved event (nothing left to write). */
async function storedUpToDate(page: Page, tabId: string): Promise<boolean> {
  const { checkpoint, lastSeq } = await chatProjection(page, tabId)
  return checkpoint !== null && checkpoint.seq === lastSeq
}

/** How the hub opens the tab for a client of this reducer version. */
function openKind(page: Page, tabId: string): Promise<string> {
  return page.evaluate(
    ({ tabId, version }) =>
      window
        .getTrpcVanillaClient()
        .chat.openTimeline.query({ tabId, version })
        .then((r) => r.kind),
    { tabId, version: TIMELINE_PROJECTION_VERSION }
  )
}

test.describe('Claude chat: paged history — recovery', () => {
  test.beforeEach(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('a stored page that cannot be read: opened again from the events, the stored projection thrown away', async ({
    chat
  }) => {
    test.setTimeout(240_000)
    const t = await chat.openTask({
      title: 'Paged unreadable page',
      spawn: 'on-send',
      seedEvents: answeredLongSessionEvents(EVENTS),
      scenario: { processes: [] }
    })
    const timeline = t.panel.getByTestId('chat-timeline-scroller')
    await expect(timeline.getByText(LAST_REPLY)).toBeVisible({ timeout: 60_000 })
    expect(await openKind(t.page, t.tabId)).toBe('paged')
    // Stored (as of the newest event), then page 0 damaged.
    await expect.poll(() => storedUpToDate(t.page, t.tabId), { timeout: 20_000 }).toBe(true)
    await chatProjection(t.page, t.tabId, 'corrupt-page')

    await t.composer.focus()
    await t.page.keyboard.press('Meta+ArrowUp')
    await expect(timeline.getByText(FIRST_PROMPT)).toBeVisible({ timeout: 30_000 })
    await t.page.keyboard.press('Meta+ArrowDown')
    await expect(timeline.getByText(LAST_REPLY)).toBeVisible({ timeout: 20_000 })
    // Thrown away; this computer tab no longer serves pages.
    await expect.poll(() => checkpoint(t.page, t.tabId), { timeout: 10_000 }).toBeNull()
    expect(await openKind(t.page, t.tabId)).toBe('full')
  })

  test('cold computer conversation after hub restart: corrupt checkpoint rebuilt, same content', async ({
    chat,
    electronApp,
    mainWindow
  }) => {
    test.setTimeout(240_000)
    const t = await chat.openTask({
      title: 'Paged corrupt checkpoint',
      spawn: 'on-send',
      seedEvents: answeredLongSessionEvents(EVENTS),
      scenario: { processes: [] }
    })
    const timeline = t.panel.getByTestId('chat-timeline-scroller')
    await expect(timeline.getByText(LAST_REPLY)).toBeVisible({ timeout: 60_000 })
    await expect.poll(() => storedUpToDate(t.page, t.tabId), { timeout: 20_000 }).toBe(true)
    // Flush/unload the computer's in-memory conversation before damaging its checkpoint.
    await chatProjection(t.page, t.tabId, 'corrupt-checkpoint')

    // The hub restarts (its tabs load again from what is stored).
    type Status = { health: string; pid: number | null }
    const status = async (): Promise<Status> =>
      (await mainWindow.evaluate(() => window.__testInvoke('app:get-sidecar-status'))) as Status
    await expect.poll(async () => (await status()).health, { timeout: 30_000 }).toBe('ready')
    const before = await status()
    await electronApp.evaluate((_electron, pid) => {
      process.kill(pid, 'SIGKILL')
    }, before.pid!)
    await expect
      .poll(
        async () => {
          const s = await status()
          return s.health === 'ready' && s.pid !== before.pid
        },
        { timeout: 30_000 }
      )
      .toBe(true)

    // Rebuilt from the events and stored again; served paged.
    await t.page.reload({ waitUntil: 'domcontentloaded' })
    await expect(t.page.locator('[data-chat-panel]:visible')).toHaveCount(1, { timeout: 30_000 })
    const panel = t.page.locator('[data-chat-panel]:visible')
    const again = panel.getByTestId('chat-timeline-scroller')
    await expect(again.getByText(LAST_REPLY)).toBeVisible({ timeout: 60_000 })
    await expect
      .poll(async () => (await checkpoint(t.page, t.tabId))?.data.startsWith('{"'), {
        timeout: 20_000
      })
      .toBe(true)
    expect(await openKind(t.page, t.tabId)).toBe('paged')
    expect(Number(await again.getAttribute('data-rows-loaded'))).toBeLessThan(512)
    await panel.locator('textarea').first().focus()
    await t.page.keyboard.press('Meta+ArrowUp')
    await expect(again.getByText(FIRST_PROMPT)).toBeVisible({ timeout: 30_000 })
  })
})
