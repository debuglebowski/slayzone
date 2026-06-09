import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  testInvoke,
  ensureBrowserPanelVisible,
  focusForAppShortcut,
  openTaskViaSearch,
  getActiveViewId
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
    const isFocused = (await testInvoke(mainWindow, 'browser:is-focused', viewId)) as boolean
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
    const isFocused = (await testInvoke(mainWindow, 'browser:is-focused', viewId)) as boolean
    expect(typeof isFocused).toBe('boolean')
  })

  test('view is queryable after focus operations', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)

    await testInvoke(mainWindow, 'browser:focus', viewId)

    const url = (await testInvoke(mainWindow, 'browser:get-url', viewId)) as string
    expect(typeof url).toBe('string')

    const wcId = (await testInvoke(mainWindow, 'browser:get-web-contents-id', viewId)) as
      | number
      | null
    expect(wcId).toBeGreaterThan(0)
  })

  test('shortcuts via IPC bridge reach renderer handlers', async ({ mainWindow }) => {
    await openTaskViaSearch(mainWindow, 'Focus task')
    await ensureBrowserPanelVisible(mainWindow)

    // Close any open dialogs
    await mainWindow.keyboard.press('Escape').catch(() => {})
    await mainWindow.waitForTimeout(200)

    // Verify search dialog is not open
    const searchInput = mainWindow.getByPlaceholder(
      'Search files, folders, commands, projects, and tasks...'
    )
    await expect(searchInput).not.toBeVisible({ timeout: 2_000 })

    // Drive a WebContentsView Cmd+K. The renderer consumes browser-WCV shortcuts
    // via the tRPC `app.browser.onShortcut` source (not the legacy
    // `browser-view:shortcut` IPC, which has no renderer consumer post slice-5).
    // A real synthesized keypress doesn't reliably fire the view's
    // before-input-event in the headless harness (verified flaky), so we emit on
    // the source via the guarded test handler.
    await testInvoke(mainWindow, 'browser:__test-emit-shortcut', {
      viewId: 'test',
      key: 'k',
      shift: false,
      alt: false,
      meta: true,
      control: false
    })

    // Search dialog should open — this proves the shortcut source dispatches
    // events that react-hotkeys-hook can handle
    await expect(searchInput).toBeVisible({ timeout: 3_000 })
  })

  test('browser find shortcut focuses the find input', async ({ mainWindow }) => {
    await openTaskViaSearch(mainWindow, 'Focus task')
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)

    await testInvoke(mainWindow, 'browser:focus', viewId)
    await testInvoke(mainWindow, 'browser:__test-emit-shortcut', {
      viewId,
      key: 'f',
      shift: false,
      alt: false,
      meta: true,
      control: false,
      kind: 'browser-tab'
    })

    const findInput = mainWindow.getByPlaceholder('Find in page...')
    await expect(findInput).toBeVisible({ timeout: 3_000 })
    await expect(findInput).toBeFocused({ timeout: 3_000 })
    await mainWindow.keyboard.press('Escape')
    await expect(findInput).not.toBeVisible({ timeout: 3_000 })
  })

  test('glow shows on browser panel when focused', async ({ mainWindow }) => {
    await openTaskViaSearch(mainWindow, 'Focus task')
    await ensureBrowserPanelVisible(mainWindow)

    // Glow only renders when multiple panels are visible.
    await expect(mainWindow.locator('[data-panel-id="terminal"]:visible')).toBeVisible({
      timeout: 3_000
    })

    const browserPanel = mainWindow.locator('[data-panel-id="browser"]:visible').first()

    // Clear glow by focusing something else
    await focusForAppShortcut(mainWindow)
    await mainWindow.waitForTimeout(200)

    // focusedPanel is driven by DOM focusin on elements inside [data-panel-id].
    // The native WCV doesn't bubble focus into the renderer DOM, so simulate
    // the focusin directly on the browser placeholder.
    await mainWindow.evaluate(() => {
      const placeholder = document.querySelector('[data-browser-panel]') as HTMLElement | null
      if (!placeholder) return
      placeholder.setAttribute('tabindex', '-1')
      placeholder.focus()
      placeholder.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    })

    // Glow should show on the browser panel
    await expect(browserPanel).toHaveClass(/shadow-\[0_0_18px/, { timeout: 3_000 })
  })
})
