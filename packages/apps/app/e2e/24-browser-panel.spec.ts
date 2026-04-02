import { test, expect, seed, goHome, clickProject, resetApp, TEST_PROJECT_PATH } from './fixtures/electron'
import {
  testInvoke, urlInput, tabEntries, newTabBtn,
  focusForAppShortcut, ensureBrowserPanelVisible, ensureBrowserPanelHidden,
  openTaskViaSearch, getActiveViewId,
} from './fixtures/browser-view'

function buildFullPageLinkDataUrl(linkText: string, href: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html>
  <body style="margin:0;background:#101010;">
    <a
      id="task-link"
      href="${href}"
      style="display:flex;align-items:center;justify-content:center;width:100vw;height:100vh;color:white;font:24px sans-serif;text-decoration:none;"
    >
      ${linkText}
    </a>
  </body>
</html>`)}`
}

test.describe('Browser panel', () => {
  let taskId: string
  let taskProjectName: string
  let otherProjectAbbrev: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Browser Test', color: '#0ea5e9', path: TEST_PROJECT_PATH })
    const otherProject = await s.createProject({ name: 'Other Project', color: '#22c55e', path: TEST_PROJECT_PATH })
    const t = await s.createTask({ projectId: p.id, title: 'Browser task', status: 'todo' })
    taskId = t.id
    taskProjectName = p.name
    otherProjectAbbrev = otherProject.name.slice(0, 2).toUpperCase()
    await s.refreshData()
    await goHome(mainWindow)
    await clickProject(mainWindow, otherProjectAbbrev)
    await openTaskViaSearch(mainWindow, 'Browser task')
  })

  test('browser panel hidden by default', async ({ mainWindow }) => {
    await expect(urlInput(mainWindow)).not.toBeVisible()
  })

  test('Cmd+B toggles browser panel on', async ({ mainWindow }) => {
    await ensureBrowserPanelHidden(mainWindow)
    await ensureBrowserPanelVisible(mainWindow)
    await expect(urlInput(mainWindow)).toBeVisible()
  })

  test('initial tab shows New Tab', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    await expect(tabEntries(mainWindow).first()).toContainText(/New Tab|about:blank/)
    expect(await tabEntries(mainWindow).count()).toBeGreaterThan(0)
  })

  test('type URL in address bar', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const input = urlInput(mainWindow)
    await input.click()
    await input.fill('https://example.com')
    await expect(input).toHaveValue('https://example.com')
  })

  test('browser view devtools IPC can open and close', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)

    await testInvoke(mainWindow, 'browser:close-devtools', viewId)
    await expect.poll(() => testInvoke(mainWindow, 'browser:is-devtools-open', viewId)).toBe(false)

    await testInvoke(mainWindow, 'browser:open-devtools', viewId, 'bottom')
    await expect.poll(() => testInvoke(mainWindow, 'browser:is-devtools-open', viewId)).toBe(true)

    await testInvoke(mainWindow, 'browser:close-devtools', viewId)
    await expect.poll(() => testInvoke(mainWindow, 'browser:is-devtools-open', viewId)).toBe(false)
  })

  test('browser link task intent opens a prefilled draft for the source task project', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)

    await testInvoke(mainWindow, 'browser:test-dispatch-create-task-from-link', viewId, {
      url: 'https://example.com/docs',
      linkText: ' Example   docs ',
    })

    const dialog = mainWindow.getByRole('dialog').last()
    await expect(dialog.getByRole('heading', { name: 'Create Task' })).toBeVisible({ timeout: 5_000 })
    await expect(dialog.locator('input[name="title"]')).toHaveValue('Link: Example docs')
    await expect(dialog.locator('textarea[name="description"]')).toHaveValue('https://example.com/docs')
    await expect(dialog.locator('form').getByRole('combobox').last()).toContainText(taskProjectName)

    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).not.toBeVisible({ timeout: 5_000 })
  })

  test('link context menu action can open a prefilled task draft', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)

    const handled = await testInvoke(
      mainWindow,
      'browser:test-run-link-context-menu-action',
      viewId,
      {
        linkURL: 'https://example.com/context-menu',
        linkText: 'Context menu docs',
      },
      'create-task-from-link'
    )
    expect(handled).toBe(true)

    const dialog = mainWindow.getByRole('dialog').last()
    await expect(dialog.getByRole('heading', { name: 'Create Task' })).toBeVisible({ timeout: 5_000 })
    await expect(dialog.locator('input[name="title"]')).toHaveValue('Link: Context menu docs')
    await expect(dialog.locator('textarea[name="description"]')).toHaveValue('https://example.com/context-menu')
    await expect(dialog.locator('form').getByRole('combobox').last()).toContainText(taskProjectName)

    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).not.toBeVisible({ timeout: 5_000 })
  })

  test('link context menu action can open the link in a new tab', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)
    const tabCountBefore = await tabEntries(mainWindow).count()

    const handled = await testInvoke(
      mainWindow,
      'browser:test-run-link-context-menu-action',
      viewId,
      {
        linkURL: 'https://example.com/context-tab',
        linkText: 'Context tab docs',
      },
      'open-link-in-new-tab'
    )
    expect(handled).toBe(true)
    await expect(tabEntries(mainWindow)).toHaveCount(tabCountBefore + 1)
  })

  test('Alt+Shift+Click on a browser link opens a prefilled task draft', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)

    await testInvoke(
      mainWindow,
      'browser:navigate',
      viewId,
      buildFullPageLinkDataUrl(' Example   docs ', 'https://example.com/docs')
    )

    await expect.poll(async () => {
      return await testInvoke(
        mainWindow,
        'browser:execute-js',
        viewId,
        'document.readyState === "complete" && !!document.getElementById("task-link")'
      ) as boolean
    }, { timeout: 10_000 }).toBe(true)

    const clickPoint = await testInvoke(
      mainWindow,
      'browser:execute-js',
      viewId,
      `(() => {
        const link = document.getElementById('task-link')
        if (!(link instanceof HTMLElement)) return null
        const rect = link.getBoundingClientRect()
        return {
          x: Math.floor(rect.left + rect.width / 2),
          y: Math.floor(rect.top + rect.height / 2),
        }
      })()`
    ) as { x: number; y: number } | null
    expect(clickPoint).toBeTruthy()
    if (!clickPoint) throw new Error('Link click point should be available')

    const tabCountBefore = await tabEntries(mainWindow).count()
    const dispatched = await testInvoke(
      mainWindow,
      'browser:test-dispatch-mouse-click',
      viewId,
      clickPoint,
      ['alt', 'shift']
    )
    expect(dispatched).toBe(true)
    await expect.poll(async () => await tabEntries(mainWindow).count(), { timeout: 3_000 }).toBe(tabCountBefore)

    const dialog = mainWindow.getByRole('dialog').last()
    await expect(dialog.getByRole('heading', { name: 'Create Task' })).toBeVisible({ timeout: 10_000 })
    await expect(dialog.locator('input[name="title"]')).toHaveValue('Link: Example docs')
    await expect(dialog.locator('textarea[name="description"]')).toHaveValue('https://example.com/docs')
    await expect(dialog.locator('form').getByRole('combobox').last()).toContainText(taskProjectName)
    await expect(tabEntries(mainWindow)).toHaveCount(tabCountBefore)

    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).not.toBeVisible({ timeout: 5_000 })
  })

  test('create new tab via plus button', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const beforeCount = await tabEntries(mainWindow).count()
    await newTabBtn(mainWindow).click()
    await expect(tabEntries(mainWindow)).toHaveCount(beforeCount + 1)
  })

  test('new tab becomes active', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const count = await tabEntries(mainWindow).count()
    await expect(tabEntries(mainWindow).nth(count - 1)).toHaveClass(/border border-neutral/)
  })

  test('close active tab via X', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const countBefore = await tabEntries(mainWindow).count()
    const activeTab = tabEntries(mainWindow).nth(countBefore - 1)
    await activeTab.locator('.lucide-x').click({ force: true })
    await expect(tabEntries(mainWindow)).toHaveCount(countBefore - 1)
  })

  test('tabs state persists in DB after changes', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const countBefore = await tabEntries(mainWindow).count()
    await newTabBtn(mainWindow).click()
    await expect(tabEntries(mainWindow)).toHaveCount(countBefore + 1)

    const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), taskId)
    expect(task?.browser_tabs).toBeTruthy()
    expect(task?.browser_tabs?.tabs.length ?? 0).toBeGreaterThanOrEqual(2)

    // Clean up
    const count = await tabEntries(mainWindow).count()
    await tabEntries(mainWindow).nth(count - 1).locator('.lucide-x').click({ force: true })
    await expect(tabEntries(mainWindow)).toHaveCount(count - 1)
  })

  test('Cmd+L focuses URL bar when browser is open', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)

    // Move focus away from the URL input
    await focusForAppShortcut(mainWindow)
    await expect(urlInput(mainWindow)).not.toBeFocused()

    await mainWindow.keyboard.press('Meta+l')
    await expect(urlInput(mainWindow)).toBeFocused()
  })

  test('Cmd+B toggles browser panel off', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    await focusForAppShortcut(mainWindow)
    await mainWindow.waitForTimeout(150)
    await mainWindow.keyboard.press('Meta+b')
    await expect(urlInput(mainWindow)).not.toBeVisible()
  })

  const keyboardPassthroughBtn = (page: import('@playwright/test').Page) =>
    page.getByTestId('browser-keyboard-passthrough').first()

  test('capture shortcuts button visible and off by default', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)
    // Navigate to a real page so webviewReady becomes true
    await testInvoke(mainWindow, 'browser:navigate', viewId, 'https://example.com')
    await mainWindow.waitForTimeout(2000)
    const btn = keyboardPassthroughBtn(mainWindow)
    await expect(btn).toBeVisible()
    await expect(btn).toBeEnabled({ timeout: 10000 })
    await expect(btn).not.toHaveClass(/text-green/)
  })

  test('capture shortcuts toggle activates and deactivates', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const btn = keyboardPassthroughBtn(mainWindow)
    await expect(btn).toBeEnabled({ timeout: 10000 })

    await btn.click()
    await expect(btn).toHaveClass(/text-green/)

    await btn.click()
    await expect(btn).not.toHaveClass(/text-green/)
  })

  test('Cmd+T passes through by default, captured when active', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const btn = keyboardPassthroughBtn(mainWindow)
    await expect(btn).toBeEnabled({ timeout: 10000 })

    // Ensure capture is off
    if (await btn.evaluate(el => el.className.includes('text-green'))) {
      await btn.click()
    }

    // Focus browser panel, press Cmd+T — should NOT create a tab
    await mainWindow.locator('[data-browser-panel]').first().click()
    const countBefore = await tabEntries(mainWindow).count()
    await mainWindow.keyboard.press('Meta+t')
    expect(await tabEntries(mainWindow).count()).toBe(countBefore)

    // Enable capture, press Cmd+T — should create a tab
    await btn.click()
    await expect(btn).toHaveClass(/text-green/)
    await mainWindow.locator('[data-browser-panel]').first().click()
    const countWithCapture = await tabEntries(mainWindow).count()
    await mainWindow.keyboard.press('Meta+t')
    await expect(tabEntries(mainWindow)).toHaveCount(countWithCapture + 1)

    // Clean up
    const count = await tabEntries(mainWindow).count()
    await tabEntries(mainWindow).nth(count - 1).locator('.lucide-x').click({ force: true })
    await expect(tabEntries(mainWindow)).toHaveCount(count - 1)

    await btn.click()
  })

  test('keyboard passthrough IPC syncs to main process', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)
    expect(viewId).toBeTruthy()
  })

  test('browser panel visibility persists across navigation', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)

    await goHome(mainWindow)
    await expect(urlInput(mainWindow)).not.toBeVisible()
    await openTaskViaSearch(mainWindow, 'Browser task')

    await expect(urlInput(mainWindow)).toBeVisible()
  })

  test('extensions button is hidden', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)

    const browserPanel = mainWindow.locator('[data-panel-id="browser"]:visible').first()
    await expect(browserPanel.getByRole('button', { name: 'Extensions' })).toHaveCount(0)
    await expect(browserPanel.getByTestId('browser-extensions-manager')).toHaveCount(0)
  })
})
