/**
 * Paged chat history (chat F), recovery: the hub's stored projection is derived
 * from the saved events and safe to throw away.
 * - A stored page that cannot be read: the client opens again from the events
 *   (same content), and the stored projection is thrown away.
 * - The hub restarting over a corrupt checkpoint: the tab opens paged again,
 *   from a projection rebuilt from the events (same content).
 */
import type { ElectronApplication, Page } from '@playwright/test'
import { TIMELINE_PROJECTION_VERSION } from '@slayzone/terminal/timeline-checkpoint'
import { resetApp } from '../fixtures/electron'
import { expect, test } from '../fixtures/chat'
import { FIRST_PROMPT, LAST_REPLY, answeredLongSessionEvents } from '../fixtures/chat-long-session'

const EVENTS = 20_000

type Db = {
  get: (sql: string, params?: unknown[]) => Promise<unknown>
  run: (sql: string, params?: unknown[]) => Promise<unknown>
}

function sql(
  app: ElectronApplication,
  op: 'get' | 'run',
  query: string,
  params: unknown[]
): Promise<unknown> {
  return app.evaluate(
    async ({}, { op, query, params }) => {
      const db = (globalThis as Record<string, unknown>).__db as Db
      return db[op](query, params)
    },
    { op, query, params }
  )
}

/** The tab's stored checkpoint (null: none). */
async function checkpoint(
  app: ElectronApplication,
  tabId: string
): Promise<{ version: string; seq: number; data: string } | null> {
  const row = await sql(
    app,
    'get',
    'SELECT version, seq, data FROM chat_timeline_checkpoints WHERE tab_id = ?',
    [tabId]
  ).catch(() => null)
  return (row as { version: string; seq: number; data: string } | undefined) ?? null
}

/** Stored as of the tab's newest saved event (nothing left to write). */
async function storedUpToDate(app: ElectronApplication, tabId: string): Promise<boolean> {
  const last = (await sql(app, 'get', 'SELECT MAX(seq) AS seq FROM chat_events WHERE tab_id = ?', [
    tabId
  ]).catch(() => null)) as { seq: number } | null
  const cp = await checkpoint(app, tabId)
  return last !== null && cp !== null && cp.seq === last.seq
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
    chat,
    electronApp
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
    await expect.poll(() => storedUpToDate(electronApp, t.tabId), { timeout: 20_000 }).toBe(true)
    await sql(
      electronApp,
      'run',
      `UPDATE chat_timeline_pages SET rows = '{oops' WHERE tab_id = ? AND page = 0`,
      [t.tabId]
    )

    await t.composer.focus()
    await t.page.keyboard.press('Meta+ArrowUp')
    await expect(timeline.getByText(FIRST_PROMPT)).toBeVisible({ timeout: 30_000 })
    await t.page.keyboard.press('Meta+ArrowDown')
    await expect(timeline.getByText(LAST_REPLY)).toBeVisible({ timeout: 20_000 })
    // Thrown away; this hub tab no longer serves pages.
    await expect.poll(() => checkpoint(electronApp, t.tabId), { timeout: 10_000 }).toBeNull()
    expect(await openKind(t.page, t.tabId)).toBe('full')
  })

  test('the hub restarting over a corrupt checkpoint: rebuilt, paged again, same content', async ({
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
    await expect.poll(() => storedUpToDate(electronApp, t.tabId), { timeout: 20_000 }).toBe(true)
    await sql(
      electronApp,
      'run',
      `UPDATE chat_timeline_checkpoints SET data = '{oops' WHERE tab_id = ?`,
      [t.tabId]
    )

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
      .poll(async () => (await checkpoint(electronApp, t.tabId))?.data.startsWith('{"'), {
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
