import { test, expect, seed, resetApp} from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  switchTerminalMode,
  getMainSessionId,
  waitForPtySession,
} from '../fixtures/terminal'
import {
  ensureBrowserPanelVisible,
  getActiveViewId,
  openTaskViaSearch,
  testInvoke,
} from '../fixtures/browser-view'
import { getTestUrl, TEST_HOST_MATCH } from '../fixtures/test-server'

test.describe('DOM picker to terminal', () => {
  const projectName = 'ZZDomPickerTest'
  let taskId: string
  let sessionId: string
  let viewId: string

  const pickerButton = (page: import('@playwright/test').Page) =>
    page.locator('[data-testid="browser-pick-element"]:visible').first()

  const activeOverlay = (page: import('@playwright/test').Page) =>
    page.locator('[data-testid="browser-picker-active-overlay"]:visible').first()

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: projectName, color: '#22c55e', path: TEST_PROJECT_PATH })
    const t = await s.createTask({ projectId: p.id, title: 'DOM picker task', status: 'todo' })
    taskId = t.id
    sessionId = getMainSessionId(taskId)
    await s.refreshData()

    await openTaskViaSearch(mainWindow, 'DOM picker task')
    await expect(mainWindow.locator('[data-testid="terminal-mode-trigger"]:visible').first()).toBeVisible({ timeout: 5_000 })
    await expect(mainWindow.locator('[data-testid="terminal-tabbar"]:visible').first()).toBeVisible({ timeout: 5_000 })
    await switchTerminalMode(mainWindow, 'terminal')
    await waitForPtySession(mainWindow, sessionId)

    await ensureBrowserPanelVisible(mainWindow)
    await expect(mainWindow.locator('[data-browser-panel="true"]:visible').first()).toBeVisible({ timeout: 5_000 })
    viewId = await getActiveViewId(mainWindow, taskId)
  })

  test.beforeEach(async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)

    await testInvoke(mainWindow, 'browser:navigate', viewId, await getTestUrl('/'))
    await expect.poll(async () => {
      return String(await testInvoke(mainWindow, 'browser:get-url', viewId) ?? '')
    }, { timeout: 15_000 }).toContain(TEST_HOST_MATCH)

    await expect(pickerButton(mainWindow)).toBeEnabled({ timeout: 10_000 })

    if (await activeOverlay(mainWindow).isVisible().catch(() => false)) {
      await pickerButton(mainWindow).click()
      await expect(activeOverlay(mainWindow)).not.toBeVisible({ timeout: 3_000 })
    }
  })

  test('picker button enables selection mode', async ({ mainWindow }) => {
    const pickButton = pickerButton(mainWindow)
    const overlay = activeOverlay(mainWindow)

    await expect(pickButton).toBeVisible({ timeout: 5_000 })
    if (await overlay.isVisible().catch(() => false)) {
      await pickButton.click()
      await expect(overlay).not.toBeVisible({ timeout: 3_000 })
    }
    await expect(overlay).not.toBeVisible()
    await pickButton.click()

    await expect(overlay).toBeVisible({ timeout: 3_000 })
  })

  test('clicking picker button again toggles selection mode off', async ({ mainWindow }) => {
    const pickButton = pickerButton(mainWindow)
    const overlay = activeOverlay(mainWindow)

    if (!(await overlay.isVisible().catch(() => false))) {
      await pickButton.click()
    }
    await expect(overlay).toBeVisible({ timeout: 3_000 })

    await pickButton.click()
    await expect(overlay).not.toBeVisible({ timeout: 3_000 })
  })

  test('Cmd+Shift+L enables picker without browser focus', async ({ mainWindow }) => {
    const pickButton = pickerButton(mainWindow)
    const overlay = activeOverlay(mainWindow)
    if (await overlay.isVisible().catch(() => false)) {
      await pickButton.click()
      await expect(overlay).not.toBeVisible({ timeout: 3_000 })
    }

    // Focus terminal to prove task-level shortcut works cross-panel.
    await mainWindow.locator('.xterm-screen:visible').first().click()
    await mainWindow.keyboard.press('Meta+Shift+L')

    await expect(overlay).toBeVisible({ timeout: 3_000 })

    // Use button toggle for deterministic shutdown.
    await pickButton.click()
    await expect(overlay).not.toBeVisible({ timeout: 3_000 })
  })

  test('Escape exits picker mode', async ({ mainWindow }) => {
    const pickButton = pickerButton(mainWindow)
    const overlay = activeOverlay(mainWindow)

    if (!(await overlay.isVisible().catch(() => false))) {
      await pickButton.click()
    }
    await expect(overlay).toBeVisible({ timeout: 3_000 })

    await mainWindow.keyboard.press('Escape')
    await expect(overlay).not.toBeVisible({ timeout: 3_000 })
  })
})
