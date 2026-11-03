/**
 * The sidebar's startup card: while a restored workspace is still coming up, the
 * sidebar footer says so ("Starting up", tabs loaded N/M, agents starting), and
 * the card goes away by itself once everything is up — it is for startup only.
 *
 * The boot is made slow on purpose (every idle callback held back), the way a busy
 * box makes it: otherwise a quick boot finishes before the card's show-delay and,
 * by design, never shows it.
 *
 * Shell tabs only (`seedBootTasks`): a shell is not an agent, so the card counts
 * tabs and shows no agent line. Agent counting is covered by the hub's own tests
 * (`agent-starts`, `pty-backend`, `chat-transport-manager`).
 */
import { test, expect } from '../fixtures/electron'
import { BOOT_TABS as TABS, openBootTabs, seedBootTasks } from '../fixtures/boot-probe'

const CARD = '[data-testid="startup-progress-card"]'

/** Holds every idle callback back, so hidden tabs hydrate slowly (as under load). */
function slowIdleCallbacks(delayMs: number): void {
  const original = window.requestIdleCallback.bind(window)
  window.requestIdleCallback = ((cb: IdleRequestCallback, opts?: IdleRequestOptions) =>
    original((deadline) => {
      setTimeout(() => cb({ didTimeout: true, timeRemaining: () => 0 }), delayMs)
      void deadline
    }, opts)) as typeof window.requestIdleCallback
}

test.describe('startup progress card', () => {
  let taskIds: string[] = []

  test.beforeAll(async ({ mainWindow }) => {
    taskIds = await seedBootTasks(mainWindow, 'Startup Card')
  })

  test('shows while restored tabs load, counts them, then goes away', async ({ mainWindow }) => {
    test.setTimeout(240_000)
    await openBootTabs(mainWindow, taskIds)
    // A settled app shows no card.
    await expect(mainWindow.locator(CARD)).toHaveCount(0)

    const slow = await mainWindow.addInitScript(slowIdleCallbacks, 150)
    await mainWindow.reload({ waitUntil: 'domcontentloaded' })
    await slow.dispose()

    const card = mainWindow.locator(CARD)
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(card).toContainText('Starting up')
    const tabs = card.locator('[data-testid="startup-progress-tabs"]')
    await expect(tabs).toHaveText(new RegExp(`^Tabs \\d+/${TABS}$`))
    // Shells only: no agent line.
    await expect(card.locator('[data-testid="startup-progress-agents"]')).toHaveCount(0)

    // It counts up as tabs load.
    const loaded = async (): Promise<number> =>
      Number(/Tabs (\d+)\//.exec((await tabs.textContent()) ?? '')?.[1] ?? -1)
    const first = await loaded()
    await expect.poll(loaded, { timeout: 60_000 }).toBeGreaterThan(first)

    // Once everything is up the card goes away by itself, and stays away.
    await expect(card).toHaveCount(0, { timeout: 90_000 })
    await mainWindow.waitForTimeout(4_000)
    await expect(card).toHaveCount(0)
  })
})
