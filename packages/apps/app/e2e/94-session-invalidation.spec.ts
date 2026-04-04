import { test, expect, seed, resetApp } from './fixtures/electron'
import { TEST_PROJECT_PATH } from './fixtures/electron'
import { openTaskTerminal, getMainSessionId } from './fixtures/terminal'

/**
 * Tests session invalidation (pty:session-not-found), reset terminal, and restart terminal.
 * Mocks pty:create, pty:kill, pty:exists to verify lifecycle without real CLIs.
 */
test.describe('Session invalidation', () => {
  let projectAbbrev: string
  let projectId: string

  /** Install pty mocks that track create/kill calls */
  const installMock = async (electronApp: import('electron').ElectronApplication) => {
    await electronApp.evaluate(({ ipcMain }) => {
      const g = globalThis as unknown as {
        __ptyCreateCount: number
        __lastPtyCreateOpts: unknown
        __ptyKillCalls: string[]
        __ptyExistsOverride: boolean
      }
      g.__ptyCreateCount = 0
      g.__lastPtyCreateOpts = null
      g.__ptyKillCalls = []
      // Start with false so Terminal.tsx takes the create path (not the "already exists" path)
      g.__ptyExistsOverride = false

      ipcMain.removeHandler('pty:create')
      ipcMain.handle('pty:create', async (_event, opts) => {
        g.__ptyCreateCount += 1
        g.__lastPtyCreateOpts = opts
        // After create, make exists return true so component thinks PTY is alive
        ;(globalThis as unknown as { __ptyExistsOverride: boolean }).__ptyExistsOverride = true
        // Emit state change so terminal UI renders (avoids 3s watchdog → dead)
        setTimeout(() => {
          _event.sender.send('pty:state-change', opts.sessionId, 'running', 'starting')
        }, 100)
        return { success: true }
      })

      ipcMain.removeHandler('pty:kill')
      ipcMain.handle('pty:kill', async (_event, sessionId: string) => {
        g.__ptyKillCalls.push(sessionId)
        // After kill, PTY no longer exists — so remount triggers a fresh pty:create
        ;(globalThis as unknown as { __ptyExistsOverride: boolean }).__ptyExistsOverride = false
        return true
      })

      ipcMain.removeHandler('pty:exists')
      ipcMain.handle('pty:exists', async () => {
        return (globalThis as unknown as { __ptyExistsOverride: boolean }).__ptyExistsOverride
      })

      // Mock buffer/state queries so terminal init doesn't error
      ipcMain.removeHandler('pty:getState')
      ipcMain.handle('pty:getState', async () => null)
      ipcMain.removeHandler('pty:getBufferSince')
      ipcMain.handle('pty:getBufferSince', async () => ({ chunks: [], currentSeq: 0 }))
    })
  }

  const getCreateCount = (electronApp: import('electron').ElectronApplication) =>
    electronApp.evaluate(() => (globalThis as unknown as { __ptyCreateCount: number }).__ptyCreateCount)

  const getKillCalls = (electronApp: import('electron').ElectronApplication) =>
    electronApp.evaluate(() => (globalThis as unknown as { __ptyKillCalls: string[] }).__ptyKillCalls)

  const getLastOpts = (electronApp: import('electron').ElectronApplication) =>
    electronApp.evaluate(() => (globalThis as unknown as { __lastPtyCreateOpts: unknown }).__lastPtyCreateOpts) as Promise<{
      existingConversationId?: string | null
      mode?: string
    } | null>

  const resetCapture = (electronApp: import('electron').ElectronApplication) =>
    electronApp.evaluate(() => {
      const g = globalThis as unknown as {
        __ptyCreateCount: number
        __lastPtyCreateOpts: unknown
        __ptyKillCalls: string[]
        __ptyExistsOverride: boolean
      }
      g.__ptyCreateCount = 0
      g.__lastPtyCreateOpts = null
      g.__ptyKillCalls = []
      g.__ptyExistsOverride = false
    })

  /** Emit pty:session-not-found from main process */
  const emitSessionNotFound = (electronApp: import('electron').ElectronApplication, sessionId: string) =>
    electronApp.evaluate(({ BrowserWindow }, sid: string) => {
      const win = BrowserWindow.getAllWindows().find(
        (w) => !w.isDestroyed() && !w.webContents.getURL().startsWith('data:')
      )
      win?.webContents.send('pty:session-not-found', sid)
    }, sessionId)

  /** Open the terminal header dropdown menu */
  const openTerminalMenu = async (page: import('@playwright/test').Page) => {
    await page.locator('.lucide-ellipsis:visible, .lucide-more-horizontal:visible').first().click()
    await expect(page.locator('[role="menu"]')).toBeVisible()
  }

  test.beforeAll(async ({ electronApp, mainWindow }) => {
    await resetApp(mainWindow)
    await installMock(electronApp)

    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'SessInval', color: '#ef4444', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    projectId = p.id
    await s.refreshData()
  })

  // --- pty:session-not-found ---

  test('session-not-found clears conversationId in DB', async ({ electronApp, mainWindow }) => {
    const s = seed(mainWindow)
    const t = await s.createTask({ projectId, title: 'SI clear id', status: 'in_progress' })
    await mainWindow.evaluate(
      ({ id }) => window.api.db.updateTask({
        id,
        providerConfig: { 'claude-code': { conversationId: 'stale-id-to-clear' } },
      }),
      { id: t.id }
    )
    await s.refreshData()

    await resetCapture(electronApp)
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'SI clear id' })
    await expect.poll(() => getCreateCount(electronApp), { timeout: 10_000 }).toBeGreaterThan(0)

    const sessionId = getMainSessionId(t.id)
    await emitSessionNotFound(electronApp, sessionId)

    // conversationId should be cleared
    await expect.poll(async () => {
      const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), t.id)
      return task?.provider_config?.['claude-code']?.conversationId ?? null
    }, { timeout: 10_000 }).toBeNull()
  })

  test('session-not-found kills the PTY', async ({ electronApp, mainWindow }) => {
    const s = seed(mainWindow)
    const t = await s.createTask({ projectId, title: 'SI kill pty', status: 'in_progress' })
    await mainWindow.evaluate(
      ({ id }) => window.api.db.updateTask({
        id,
        providerConfig: { 'claude-code': { conversationId: 'stale-kill-test' } },
      }),
      { id: t.id }
    )
    await s.refreshData()

    await resetCapture(electronApp)
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'SI kill pty' })
    await expect.poll(() => getCreateCount(electronApp), { timeout: 10_000 }).toBeGreaterThan(0)

    const sessionId = getMainSessionId(t.id)
    await emitSessionNotFound(electronApp, sessionId)

    // pty:kill should have been called with the session ID
    await expect.poll(async () => {
      const kills = await getKillCalls(electronApp)
      return kills.includes(sessionId)
    }, { timeout: 10_000 }).toBe(true)
  })

  test('session invalidation only clears current mode ID (others survive)', async ({ electronApp, mainWindow }) => {
    const s = seed(mainWindow)
    const t = await s.createTask({ projectId, title: 'SI cross mode', status: 'in_progress' })
    // Set conversation IDs for both claude-code and codex
    await mainWindow.evaluate(
      ({ id }) => window.api.db.updateTask({
        id,
        providerConfig: {
          'claude-code': { conversationId: 'claude-to-clear' },
          codex: { conversationId: 'codex-should-survive' },
        },
      }),
      { id: t.id }
    )
    await s.refreshData()

    await resetCapture(electronApp)
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'SI cross mode' })
    await expect.poll(() => getCreateCount(electronApp), { timeout: 10_000 }).toBeGreaterThan(0)

    const sessionId = getMainSessionId(t.id)
    await emitSessionNotFound(electronApp, sessionId)

    // Wait for claude-code's ID to be cleared
    await expect.poll(async () => {
      const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), t.id)
      return task?.provider_config?.['claude-code']?.conversationId ?? null
    }, { timeout: 10_000 }).toBeNull()

    // codex's ID should survive
    const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), t.id)
    expect(task?.provider_config?.codex?.conversationId).toBe('codex-should-survive')
  })

  // --- Reset terminal (menu) ---

  test('reset terminal clears conversationId and remounts', async ({ electronApp, mainWindow }) => {
    const s = seed(mainWindow)
    const t = await s.createTask({ projectId, title: 'SI reset', status: 'in_progress' })
    await mainWindow.evaluate(
      ({ id }) => window.api.db.updateTask({
        id,
        providerConfig: { 'claude-code': { conversationId: 'reset-me' } },
      }),
      { id: t.id }
    )
    await s.refreshData()

    await resetCapture(electronApp)
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'SI reset' })
    await expect.poll(() => getCreateCount(electronApp), { timeout: 10_000 }).toBeGreaterThan(0)

    const countBefore = await getCreateCount(electronApp)

    // Click "Reset terminal" in dropdown menu
    await openTerminalMenu(mainWindow)
    await mainWindow.getByRole('menuitem', { name: 'Reset terminal' }).click()

    // conversationId should be cleared
    await expect.poll(async () => {
      const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), t.id)
      return task?.provider_config?.['claude-code']?.conversationId ?? null
    }, { timeout: 10_000 }).toBeNull()

    // PTY should have been killed
    const sessionId = getMainSessionId(t.id)
    await expect.poll(async () => {
      const kills = await getKillCalls(electronApp)
      return kills.includes(sessionId)
    }, { timeout: 10_000 }).toBe(true)

    // Terminal should remount (new pty:create call)
    await expect.poll(() => getCreateCount(electronApp), { timeout: 10_000 }).toBeGreaterThan(countBefore)
  })

  // --- Restart terminal (menu) ---

  test('restart terminal preserves conversationId and remounts with same ID', async ({ electronApp, mainWindow }) => {
    const storedId = 'keep-on-restart'
    const s = seed(mainWindow)
    const t = await s.createTask({ projectId, title: 'SI restart', status: 'in_progress' })
    await mainWindow.evaluate(
      ({ id, cid }) => window.api.db.updateTask({
        id,
        providerConfig: { 'claude-code': { conversationId: cid } },
      }),
      { id: t.id, cid: storedId }
    )
    await s.refreshData()

    await resetCapture(electronApp)
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'SI restart' })
    await expect.poll(() => getCreateCount(electronApp), { timeout: 10_000 }).toBeGreaterThan(0)

    const countBefore = await getCreateCount(electronApp)

    // Click "Restart terminal" in dropdown menu
    await openTerminalMenu(mainWindow)
    await mainWindow.getByRole('menuitem', { name: 'Restart terminal' }).click()

    // conversationId should be PRESERVED
    const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), t.id)
    expect(task?.provider_config?.['claude-code']?.conversationId).toBe(storedId)

    // PTY should have been killed
    const sessionId = getMainSessionId(t.id)
    await expect.poll(async () => {
      const kills = await getKillCalls(electronApp)
      return kills.includes(sessionId)
    }, { timeout: 10_000 }).toBe(true)

    // Terminal should remount with same existingConversationId
    await expect.poll(() => getCreateCount(electronApp), { timeout: 10_000 }).toBeGreaterThan(countBefore)

    const opts = await getLastOpts(electronApp)
    expect(opts?.existingConversationId).toBe(storedId)
  })
})
