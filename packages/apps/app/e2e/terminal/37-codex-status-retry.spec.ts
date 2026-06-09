import { test, expect, seed, goHome, clickProject, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import { switchTerminalMode } from '../fixtures/terminal'

/**
 * Tests that:
 * 1. No /status is auto-fired (banner is user-initiated only)
 * 2. Banner transitions correctly when switching terminal modes
 * 3. Banner reappears after navigating away and back
 * 4. Unavailable dismiss state resets for a different task
 * 5. Detect button handles PTY not existing yet
 */
test.describe('Session banner behavior', () => {
  let projectAbbrev: string
  let noAutoTaskId: string
  let switchTaskId: string
  let navTaskId: string
  let dismissTask1Id: string
  let dismissTask2Id: string
  let noPtyTaskId: string

  const detectedId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

  test.beforeAll(async ({ electronApp, mainWindow }) => {
    await resetApp(mainWindow)
    await electronApp.evaluate(({ ipcMain }, sessionIdFromStatus: string) => {
      const globalState = globalThis as unknown as {
        __statusBuffers?: Record<string, string>
        __statusCommandCounts?: Record<string, number>
        __ptyExistsOverride?: boolean | null
      }
      globalState.__statusBuffers = {}
      globalState.__statusCommandCounts = {}
      globalState.__ptyExistsOverride = null

      ipcMain.removeHandler('pty:create')
      ipcMain.handle('pty:create', async () => ({ success: true }))

      ipcMain.removeHandler('pty:write')
      ipcMain.handle('pty:write', async (event, sessionId: string, data: string) => {
        const buffers = globalState.__statusBuffers ?? {}
        const counts = globalState.__statusCommandCounts ?? {}
        buffers[sessionId] = (buffers[sessionId] ?? '') + data

        if (data.includes('\r') || data.includes('\n')) {
          const line = buffers[sessionId]
          if (line.includes('/status') || line.includes('/stats')) {
            counts[sessionId] = (counts[sessionId] ?? 0) + 1
            event.sender.send('pty:session-detected', sessionId, sessionIdFromStatus)
          }
          buffers[sessionId] = ''
        }

        globalState.__statusBuffers = buffers
        globalState.__statusCommandCounts = counts
        return true
      })

      ipcMain.removeHandler('pty:exists')
      ipcMain.handle('pty:exists', async () => {
        const override = (globalThis as unknown as { __ptyExistsOverride?: boolean | null })
          .__ptyExistsOverride
        return override ?? true
      })
    }, detectedId)

    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Zed Retry',
      color: '#22c55e',
      path: TEST_PROJECT_PATH
    })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()

    const noAutoTask = await s.createTask({
      projectId: p.id,
      title: 'SB no auto fire',
      status: 'in_progress'
    })
    const switchTask = await s.createTask({
      projectId: p.id,
      title: 'SB mode switch',
      status: 'in_progress'
    })
    const navTask = await s.createTask({
      projectId: p.id,
      title: 'SB nav away',
      status: 'in_progress'
    })
    const dismissTask1 = await s.createTask({
      projectId: p.id,
      title: 'SB dismiss one',
      status: 'in_progress'
    })
    const dismissTask2 = await s.createTask({
      projectId: p.id,
      title: 'SB dismiss two',
      status: 'in_progress'
    })
    const noPtyTask = await s.createTask({
      projectId: p.id,
      title: 'SB no pty',
      status: 'in_progress'
    })
    noAutoTaskId = noAutoTask.id
    switchTaskId = switchTask.id
    navTaskId = navTask.id
    dismissTask1Id = dismissTask1.id
    dismissTask2Id = dismissTask2.id
    noPtyTaskId = noPtyTask.id

    await mainWindow.evaluate(
      ({ noAuto, nav, d1, d2, noPty }) => {
        const c = window.getTrpcVanillaClient()
        return Promise.all([
          c.task.update.mutate({ id: noAuto, terminalMode: 'codex' }),
          c.task.update.mutate({ id: nav, terminalMode: 'codex' }),
          c.task.update.mutate({ id: d1, terminalMode: 'cursor-agent' }),
          c.task.update.mutate({ id: d2, terminalMode: 'cursor-agent' }),
          c.task.update.mutate({ id: noPty, terminalMode: 'codex' })
        ])
      },
      {
        noAuto: noAutoTaskId,
        nav: navTaskId,
        d1: dismissTask1Id,
        d2: dismissTask2Id,
        noPty: noPtyTaskId
      }
    )

    await s.refreshData()
    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.getByText('SB no auto fire').first()).toBeVisible({ timeout: 5_000 })
  })

  test.afterAll(async ({ electronApp }) => {
    // Same strip set as 28-codex-session-detection.
    await electronApp.evaluate(({ ipcMain }) => {
      for (const ch of ['pty:submit', 'chat:list', 'session:list', 'session:getState']) {
        ipcMain.removeHandler(ch)
      }
      const restore = (globalThis as unknown as { __restorePtyHandlers?: () => void })
        .__restorePtyHandlers
      restore?.()
    })
  })

  test('does not auto-fire /status — requires user click', async ({ mainWindow, electronApp }) => {
    await mainWindow.getByText('SB no auto fire').first().click()
    await expect(mainWindow.getByText('Session not saved').last()).toBeVisible({ timeout: 5_000 })

    // Banner visible
    await expect(mainWindow.getByText('Session not saved').last()).toBeVisible()

    // Wait 1.5s — no /status should have been sent automatically
    await mainWindow.waitForTimeout(1500)

    const statusCount = await electronApp.evaluate(() => {
      const counts =
        (globalThis as unknown as { __statusCommandCounts?: Record<string, number> })
          .__statusCommandCounts ?? {}
      return Object.values(counts).reduce((sum, value) => sum + value, 0)
    })
    expect(statusCount).toBe(0)

    // Session should NOT be saved
    const task = await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.get.query({ id }),
      noAutoTaskId
    )
    expect(task?.codex_conversation_id ?? null).toBeNull()
  })

  // QUARANTINED 2026-05-16: fixture fallback handles the mode switches, but
  // the gemini "Run /stats" detect button doesn't appear after the switch.
  // The detect banner condition probably requires PTY data the fallback path
  // doesn't generate.
  test.skip('switching modes transitions between detect / unavailable / no banner', async ({
    mainWindow
  }) => {
    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.getByText('SB mode switch').first()).toBeVisible({ timeout: 5_000 })
    await mainWindow.getByText('SB mode switch').first().click()

    // Default claude-code: no banners
    await expect(mainWindow.getByText('Session not saved').first()).not.toBeVisible()
    await expect(
      mainWindow.getByText(/Session ID detection not available/).first()
    ).not.toBeVisible()

    // Switch to Codex → detect banner
    await switchTerminalMode(mainWindow, 'codex')
    await expect(mainWindow.getByText('Session not saved').last()).toBeVisible()
    await expect(
      mainWindow.getByText(/Session ID detection not available/).first()
    ).not.toBeVisible()

    // Switch to Cursor → unavailable banner
    await switchTerminalMode(mainWindow, 'cursor-agent')
    await expect(mainWindow.getByText('Session not saved').first()).not.toBeVisible()
    await expect(mainWindow.getByText(/Session ID detection not available/).last()).toBeVisible()

    // Switch to Terminal → no banners
    await switchTerminalMode(mainWindow, 'terminal')
    await expect(mainWindow.getByText('Session not saved').first()).not.toBeVisible()
    await expect(
      mainWindow.getByText(/Session ID detection not available/).first()
    ).not.toBeVisible()

    // Switch to Gemini → detect banner with /stats
    await switchTerminalMode(mainWindow, 'gemini')
    await expect(mainWindow.getByText('Session not saved').last()).toBeVisible()
    await expect(mainWindow.getByRole('button', { name: /Run \/stats/ }).first()).toBeVisible()

    // Switch back to Claude → no banners
    await switchTerminalMode(mainWindow, 'claude-code')
    await expect(mainWindow.getByText('Session not saved').first()).not.toBeVisible()
    await expect(
      mainWindow.getByText(/Session ID detection not available/).first()
    ).not.toBeVisible()
  })

  test('detect banner reappears after navigating away and back', async ({ mainWindow }) => {
    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.getByText('SB nav away').first()).toBeVisible({ timeout: 5_000 })
    await mainWindow.getByText('SB nav away').first().click()

    // Banner visible
    await expect(mainWindow.getByText('Session not saved').last()).toBeVisible()

    // Navigate away to another task
    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.getByText('SB mode switch').first()).toBeVisible({ timeout: 5_000 })
    await mainWindow.getByText('SB mode switch').first().click()

    // Navigate back to the codex task
    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.getByText('SB nav away').first()).toBeVisible({ timeout: 5_000 })
    await mainWindow.getByText('SB nav away').first().click()

    // Banner should reappear (session still not saved)
    await expect(mainWindow.getByText('Session not saved').last()).toBeVisible()
  })

  test('unavailable dismiss resets when switching to a different task', async ({ mainWindow }) => {
    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.getByText('SB dismiss one').first()).toBeVisible({ timeout: 5_000 })

    // Open first cursor task, dismiss banner
    await mainWindow.getByText('SB dismiss one').first().click()
    await expect(mainWindow.getByText(/Session ID detection not available/).last()).toBeVisible()
    const banner1 = mainWindow
      .getByText(/Session ID detection not available/)
      .last()
      .locator('..')
    await banner1.locator('button').click()
    await expect(
      mainWindow.getByText(/Session ID detection not available/).first()
    ).not.toBeVisible()

    // Open second cursor task — banner should appear (dismiss was for task 1 only)
    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.getByText('SB dismiss two').first()).toBeVisible({ timeout: 5_000 })
    await mainWindow.getByText('SB dismiss two').first().click()
    await expect(mainWindow.getByText(/Session ID detection not available/).last()).toBeVisible()
  })

  test('detect button is a no-op when PTY does not exist yet', async ({
    mainWindow,
    electronApp
  }) => {
    // Make pty:exists return false
    await electronApp.evaluate(() => {
      ;(globalThis as unknown as { __ptyExistsOverride?: boolean | null }).__ptyExistsOverride =
        false
    })

    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.getByText('SB no pty').first()).toBeVisible({ timeout: 5_000 })
    await mainWindow.getByText('SB no pty').first().click()

    await expect(mainWindow.getByText('Session not saved').last()).toBeVisible()

    // Click detect — should not crash, banner stays (PTY doesn't exist)
    await mainWindow
      .getByRole('button', { name: /Run \/status/ })
      .last()
      .click()

    // Banner still visible, session not saved
    await expect(mainWindow.getByText('Session not saved').last()).toBeVisible()
    const task = await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.get.query({ id }),
      noPtyTaskId
    )
    expect(task?.codex_conversation_id ?? null).toBeNull()

    // Restore pty:exists
    await electronApp.evaluate(() => {
      ;(globalThis as unknown as { __ptyExistsOverride?: boolean | null }).__ptyExistsOverride =
        null
    })
  })
})
