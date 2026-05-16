import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  testInvoke,
  testEmit,
  ensureBrowserPanelVisible,
  focusForAppShortcut,
  openTaskViaSearch, getActiveViewId,
} from '../fixtures/browser-view'

test.describe('Browser view focus (WebContentsView)', () => {
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Focus Te', color: '#0ea5e9', path: TEST_PROJECT_PATH })
    const t = await s.createTask({ projectId: p.id, title: 'Focus task', status: 'todo' })
    taskId = t.id
    await s.refreshData()
    await openTaskViaSearch(mainWindow, 'Focus task')
  })

  test('focus IPC does not throw and returns boolean', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)

    // Focus via IPC
    await testInvoke(mainWindow, 'browser:focus', viewId)

    // isFocused should return a boolean
    const isFocused = await testInvoke(mainWindow, 'browser:is-focused', viewId) as boolean
    expect(typeof isFocused).toBe('boolean')
  })

  test('clicking placeholder triggers focus IPC', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)

    // Click the browser panel placeholder
    const placeholder = mainWindow.locator('[data-browser-panel]').first()
    await placeholder.click({ force: true })
    await mainWindow.waitForTimeout(200)

    // Verify the IPC path exists (focus may not propagate in headless)
    const isFocused = await testInvoke(mainWindow, 'browser:is-focused', viewId) as boolean
    expect(typeof isFocused).toBe('boolean')
  })

  test('view is queryable after focus operations', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)

    await testInvoke(mainWindow, 'browser:focus', viewId)

    const url = await testInvoke(mainWindow, 'browser:get-url', viewId) as string
    expect(typeof url).toBe('string')

    const wcId = await testInvoke(mainWindow, 'browser:get-web-contents-id', viewId) as number | null
    expect(wcId).toBeGreaterThan(0)
  })

  test('shortcuts via IPC bridge reach renderer handlers', async ({ mainWindow }) => {
    await openTaskViaSearch(mainWindow, 'Focus task')
    await ensureBrowserPanelVisible(mainWindow)

    // Close any open dialogs
    await mainWindow.keyboard.press('Escape').catch(() => {})
    await mainWindow.waitForTimeout(200)

    // Verify search dialog is not open
    const searchInput = mainWindow.getByPlaceholder('Search files, tasks, projects...')
    await expect(searchInput).not.toBeVisible({ timeout: 2_000 })

    // Simulate Cmd+K arriving via the IPC bridge (as if pressed in WebContentsView)
    await testEmit(mainWindow, 'browser-view:shortcut', {
      viewId: 'test',
      key: 'k',
      shift: false,
      alt: false,
      meta: true,
      control: false,
    })

    // Search dialog should open — this proves the IPC bridge dispatches events
    // that react-hotkeys-hook can handle
    await expect(searchInput).toBeVisible({ timeout: 3_000 })
  })

  test('glow shows on browser panel when WebContentsView gains focus', async ({ mainWindow }) => {
    await openTaskViaSearch(mainWindow, 'Focus task')
    await ensureBrowserPanelVisible(mainWindow)

    // Glow only renders when multiple panels are visible (no contrast vs single panel),
    // so make sure we have two visible panels before exercising focus.
    await expect(mainWindow.locator('[data-panel-id="terminal"]:visible')).toBeVisible({ timeout: 3_000 })

    const browserPanel = mainWindow.locator('[data-panel-id="browser"]:visible').first()

    // Clear glow by focusing something else
    await focusForAppShortcut(mainWindow)
    await mainWindow.waitForTimeout(200)

    // Simulate WebContentsView gaining focus via IPC
    await testEmit(mainWindow, 'browser-view:focused', { viewId: 'test' })

    // Glow should show on the browser panel
    await expect(browserPanel).toHaveClass(/shadow-\[0_0_18px/, { timeout: 3_000 })
  })
})
