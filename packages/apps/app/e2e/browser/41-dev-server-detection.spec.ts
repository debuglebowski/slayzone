import { test, expect, seed, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  getMainSessionId,
  openTaskTerminal,
  runCommand,
  waitForBufferContains,
  waitForPtySession,
  waitForPtyState
} from '../fixtures/terminal'

const urlInput = (page: import('@playwright/test').Page) =>
  page.locator('input[placeholder="Enter URL..."]:visible').first()

const toast = (page: import('@playwright/test').Page) =>
  page.locator('[data-testid="dev-server-toast"]:visible').first()

const focusForAppShortcut = async (page: import('@playwright/test').Page) => {
  await page.keyboard.press('Escape').catch(() => {})
  const sidebar = page.locator('[data-slot="sidebar"]').first()
  if (await sidebar.isVisible().catch(() => false)) {
    await sidebar.click({ position: { x: 12, y: 12 } }).catch(() => {})
  } else {
    await page
      .locator('#root')
      .click({ position: { x: 12, y: 12 } })
      .catch(() => {})
  }
}

// ── Toast basics ──────────────────────────────────────────────────────────

test.describe('Dev server URL detection', () => {
  let projectAbbrev: string
  let taskId: string
  let sessionId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)

    // Ensure clean defaults (previous runs may have left settings dirty)
    await s.setSetting('dev_server_toast_enabled', '1')
    await s.setSetting('dev_server_auto_open_browser', '0')

    const p = await s.createProject({
      name: 'Dev Detect',
      color: '#06b6d4',
      path: TEST_PROJECT_PATH
    })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()

    const t = await s.createTask({
      projectId: p.id,
      title: 'Dev server task',
      status: 'in_progress'
    })
    taskId = t.id
    sessionId = getMainSessionId(taskId)

    await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.update.mutate({ id, terminalMode: 'terminal' }),
      taskId
    )
    await s.refreshData()

    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Dev server task' })
    await waitForPtySession(mainWindow, sessionId)
    await waitForPtyState(mainWindow, sessionId, 'idle')
  })

  test('toast appears when localhost URL printed in terminal', async ({ mainWindow }) => {
    await runCommand(mainWindow, sessionId, 'echo http://localhost:3456')
    await waitForBufferContains(mainWindow, sessionId, 'http://localhost:3456')

    await expect(toast(mainWindow)).toBeVisible({ timeout: 5_000 })
    await expect(mainWindow.getByText('http://localhost:3456').first()).toBeVisible()
  })

  test('clicking Open opens browser panel with detected URL', async ({ mainWindow }) => {
    await expect(toast(mainWindow)).toBeVisible({ timeout: 5_000 })

    await toast(mainWindow).getByText('Open preview').click()

    // Browser panel should be visible
    await expect(urlInput(mainWindow)).toBeVisible({ timeout: 5_000 })

    // Toast should be dismissed
    await expect(toast(mainWindow)).not.toBeVisible({ timeout: 3_000 })

    // Verify browser tab has the URL
    const task = await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.get.query({ id }),
      taskId
    )
    const tabs = task?.browser_tabs?.tabs ?? []
    expect(tabs.some((t: { url: string }) => t.url === 'http://localhost:3456')).toBe(true)
  })

  test('dismiss hides toast', async ({ mainWindow }) => {
    // Close browser panel first (opened by previous test) so toast can appear
    await focusForAppShortcut(mainWindow)
    await mainWindow.keyboard.press('Meta+b')
    await expect(urlInput(mainWindow)).not.toBeVisible({ timeout: 3_000 })

    // Use a new URL (pty-manager dedup means previously-seen URLs won't re-fire)
    await runCommand(mainWindow, sessionId, 'echo http://localhost:7777')
    await waitForBufferContains(mainWindow, sessionId, 'http://localhost:7777')

    await expect(toast(mainWindow)).toBeVisible({ timeout: 5_000 })

    // Click X to dismiss
    await toast(mainWindow).locator('.lucide-x').click()

    await expect(toast(mainWindow)).not.toBeVisible({ timeout: 3_000 })
  })

  test('same URL does not re-trigger toast', async ({ mainWindow }) => {
    // Echo same URL again — pty-manager dedup prevents re-emission
    await runCommand(mainWindow, sessionId, 'echo http://localhost:7777')
    await waitForBufferContains(mainWindow, sessionId, 'http://localhost:7777')

    // Give the system time to potentially show a toast, then confirm it didn't
    await expect(toast(mainWindow)).not.toBeVisible({ timeout: 2_000 })
  })
})

// ── Toast disabled setting ────────────────────────────────────────────────

test.describe('Dev server detection — toast disabled', () => {
  let sessionId: string

  test.beforeAll(async ({ mainWindow }) => {
    const s = seed(mainWindow)

    // Disable toast BEFORE task mounts (settings loaded on mount)
    await s.setSetting('dev_server_toast_enabled', '0')

    const p = await s.createProject({
      name: 'NoToast Proj',
      color: '#f59e0b',
      path: TEST_PROJECT_PATH
    })
    const t = await s.createTask({ projectId: p.id, title: 'No toast task', status: 'in_progress' })
    sessionId = getMainSessionId(t.id)

    await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.update.mutate({ id, terminalMode: 'terminal' }),
      t.id
    )
    await s.refreshData()

    await openTaskTerminal(mainWindow, { projectAbbrev: 'NO', taskTitle: 'No toast task' })
    await waitForPtySession(mainWindow, sessionId)
    await waitForPtyState(mainWindow, sessionId, 'idle')
  })

  test.afterAll(async ({ mainWindow }) => {
    // Restore default
    await seed(mainWindow).setSetting('dev_server_toast_enabled', '1')
  })

  test('no toast appears when setting disabled', async ({ mainWindow }) => {
    await runCommand(mainWindow, sessionId, 'echo http://localhost:4001')
    await waitForBufferContains(mainWindow, sessionId, 'http://localhost:4001')

    await expect(toast(mainWindow)).not.toBeVisible({ timeout: 2_000 })
  })
})

// ── Auto-open setting ─────────────────────────────────────────────────────

test.describe('Dev server detection — auto-open browser', () => {
  let sessionId: string

  test.beforeAll(async ({ mainWindow }) => {
    const s = seed(mainWindow)

    // Enable auto-open BEFORE task mounts
    await s.setSetting('dev_server_auto_open_browser', '1')

    const p = await s.createProject({
      name: 'AutoOpen Proj',
      color: '#10b981',
      path: TEST_PROJECT_PATH
    })
    const t = await s.createTask({
      projectId: p.id,
      title: 'Auto open task',
      status: 'in_progress'
    })
    sessionId = getMainSessionId(t.id)

    await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.update.mutate({ id, terminalMode: 'terminal' }),
      t.id
    )
    await s.refreshData()

    await openTaskTerminal(mainWindow, { projectAbbrev: 'AU', taskTitle: 'Auto open task' })
    await waitForPtySession(mainWindow, sessionId)
    await waitForPtyState(mainWindow, sessionId, 'idle')
  })

  test.afterAll(async ({ mainWindow }) => {
    // Restore default
    await seed(mainWindow).setSetting('dev_server_auto_open_browser', '0')
  })

  test('browser panel opens automatically without toast', async ({ mainWindow }) => {
    await runCommand(mainWindow, sessionId, 'echo http://localhost:4002')
    await waitForBufferContains(mainWindow, sessionId, 'http://localhost:4002')

    // Browser panel should open automatically
    await expect(urlInput(mainWindow)).toBeVisible({ timeout: 5_000 })

    // No toast should appear
    await expect(toast(mainWindow)).not.toBeVisible()
  })

  test('closing browser does not re-trigger auto-open', async ({ mainWindow }) => {
    // Browser is open from previous test — close it
    await focusForAppShortcut(mainWindow)
    await mainWindow.keyboard.press('Meta+b')
    await expect(urlInput(mainWindow)).not.toBeVisible({ timeout: 3_000 })

    // Verify browser stays closed (one-time behavior)
    await expect(urlInput(mainWindow)).not.toBeVisible({ timeout: 2_000 })
  })
})
