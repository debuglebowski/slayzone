import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from './fixtures/electron'
import {
  urlInput,
  ensureBrowserPanelVisible,
  openTaskViaSearch,
  newTabBtn, tabEntries,
} from './fixtures/browser-view'

test.describe('Browser loading animation', () => {
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Load Anim', color: '#0ea5e9', path: TEST_PROJECT_PATH })
    const t = await s.createTask({ projectId: p.id, title: 'Loading anim task', status: 'todo' })
    taskId = t.id
    await s.refreshData()
    await openTaskViaSearch(mainWindow, 'Loading anim task')
  })

  const loadingOverlay = (page: typeof import('@playwright/test').Page.prototype) =>
    page.locator('[data-testid="browser-loading-animation"]:visible')

  test('loading animation shows immediately when browser panel opens (before any URL)', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)

    // Animation visible right away — no gray about:blank screen
    await expect(loadingOverlay(mainWindow)).toBeVisible({ timeout: 5000 })
  })

  test('loading animation persists during first navigation', async ({ mainWindow }) => {
    const input = urlInput(mainWindow)
    await input.click()
    await input.fill('https://example.com')
    await mainWindow.keyboard.press('Enter')

    // Still visible during loading
    await expect(loadingOverlay(mainWindow)).toBeVisible()
  })

  test('loading animation disappears after page loads', async ({ mainWindow }) => {
    await expect(loadingOverlay(mainWindow)).not.toBeVisible({ timeout: 15000 })
  })

  test('loading animation does not show on subsequent navigation', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)

    const input = urlInput(mainWindow)
    await input.click()
    await input.fill('https://example.org')
    await mainWindow.keyboard.press('Enter')

    // Should NOT show loading animation — page already has content
    await mainWindow.waitForTimeout(500)
    await expect(loadingOverlay(mainWindow)).not.toBeVisible()
  })

  test('new tab shows loading animation immediately', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)

    // Open a new tab — animation should show right away (no gray screen)
    await newTabBtn(mainWindow).click()
    await expect(loadingOverlay(mainWindow)).toBeVisible({ timeout: 5000 })

    // Navigate
    const input = urlInput(mainWindow)
    await input.click()
    await input.fill('https://example.com')
    await mainWindow.keyboard.press('Enter')

    // Wait for page to load — animation disappears
    await expect(loadingOverlay(mainWindow)).not.toBeVisible({ timeout: 15000 })

    // Cleanup
    const count = await tabEntries(mainWindow).count()
    await tabEntries(mainWindow).nth(count - 1).locator('.lucide-x').click({ force: true })
  })
})
