/**
 * Verifies drag-to-reorder of tabs in the in-task browser panel.
 * Identifies tabs by their persistent UUID, drags via Playwright pointer
 * events, then asserts the new order reads back from the DB via IPC.
 */
import type { Page } from '@playwright/test'
import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  newTabBtn,
  tabEntries,
  ensureBrowserPanelVisible,
  openTaskViaSearch,
  getViewsForTask
} from '../fixtures/browser-view'

interface BrowserTab {
  id: string
  url: string
  title?: string
}

async function readTabIds(page: Page, taskId: string): Promise<string[]> {
  const task = (await page.evaluate(async (id) => {
    const tasks = await window.getTrpcVanillaClient().task.getAll.query()
    return tasks.find((task) => task.id === id) ?? null
  }, taskId)) as { browser_tabs?: { tabs?: BrowserTab[] } | null } | null
  return task?.browser_tabs?.tabs?.map((t) => t.id) ?? []
}

test.describe('Browser panel — tab drag reorder', () => {
  let taskId = ''

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)

    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Browser Reorder',
      color: '#0ea5e9',
      path: TEST_PROJECT_PATH
    })
    const t = await s.createTask({ projectId: p.id, title: 'Reorder task', status: 'todo' })
    taskId = t.id
    await s.refreshData()
    await openTaskViaSearch(mainWindow, 'Reorder task')
    await ensureBrowserPanelVisible(mainWindow)

    // Default panel opens with 1 tab. Add 2 more for 3 total.
    await newTabBtn(mainWindow).click()
    await newTabBtn(mainWindow).click()
    await expect
      .poll(async () => (await getViewsForTask(mainWindow, taskId)).length, { timeout: 10_000 })
      .toBe(3)
    await expect
      .poll(async () => (await readTabIds(mainWindow, taskId)).length, { timeout: 10_000 })
      .toBe(3)
  })

  test('drag first tab past last tab — order becomes [b, c, a]', async ({ mainWindow }) => {
    const initial = await readTabIds(mainWindow, taskId)
    expect(initial).toHaveLength(3)
    const [a, b, c] = initial

    const entries = tabEntries(mainWindow)
    await expect(entries).toHaveCount(3)

    const srcBox = await entries.nth(0).boundingBox()
    const dstBox = await entries.nth(2).boundingBox()
    if (!srcBox || !dstBox) throw new Error('tab bounding boxes unavailable')

    const startX = srcBox.x + srcBox.width / 2
    const startY = srcBox.y + srcBox.height / 2
    // Drop near right edge of last tab so dnd-kit places after it.
    const endX = dstBox.x + dstBox.width - 4
    const endY = dstBox.y + dstBox.height / 2

    await mainWindow.mouse.move(startX, startY)
    await mainWindow.mouse.down()
    // Exceed PointerSensor activation distance (5px) before main drag.
    await mainWindow.mouse.move(startX + 12, startY, { steps: 5 })
    await mainWindow.mouse.move(endX, endY, { steps: 15 })
    await mainWindow.mouse.up()

    await expect.poll(() => readTabIds(mainWindow, taskId), { timeout: 5_000 }).toEqual([b, c, a])
  })

  test('clicking close button does NOT trigger drag/reorder', async ({ mainWindow }) => {
    // After previous test, order is [b, c, a]. Capture, close idx 1 — order should be [b, a].
    const before = await readTabIds(mainWindow, taskId)
    expect(before).toHaveLength(3)
    const [b, , a] = before

    const entries = tabEntries(mainWindow)
    const closeBtn = entries.nth(1).locator('button:has(.lucide-x)').first()
    await closeBtn.click()

    await expect(tabEntries(mainWindow)).toHaveCount(2)
    await expect.poll(() => readTabIds(mainWindow, taskId), { timeout: 5_000 }).toEqual([b, a])
  })
})
