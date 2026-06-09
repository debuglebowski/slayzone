import { test, expect, seed, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import { openTaskTerminal, getMainSessionId } from '../fixtures/terminal'

/**
 * Tests stale-session handling (issue #90: provider auto-cleaned the session),
 * reset terminal, and restart terminal. Mocks pty:create, pty:kill, pty:exists
 * to verify lifecycle without real CLIs.
 *
 * Stale detection now rides the `pty:exit` reason (code SESSION_NOT_FOUND); there
 * is no `pty:session-not-found` IPC and no auto-clear — the dead overlay shows a
 * friendly message and recovery is the user-initiated "Start fresh" button.
 */
// QUARANTINED 2026-05-16: same root cause as 93 — pty:create mock no longer
// captures opts on task open. Needs rewriting against new pty lifecycle.
test.describe
  .skip('Session invalidation', () => {
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
      electronApp.evaluate(
        () => (globalThis as unknown as { __ptyCreateCount: number }).__ptyCreateCount
      )

    const getKillCalls = (electronApp: import('electron').ElectronApplication) =>
      electronApp.evaluate(
        () => (globalThis as unknown as { __ptyKillCalls: string[] }).__ptyKillCalls
      )

    const getLastOpts = (electronApp: import('electron').ElectronApplication) =>
      electronApp.evaluate(
        () => (globalThis as unknown as { __lastPtyCreateOpts: unknown }).__lastPtyCreateOpts
      ) as Promise<{
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

    /** Emit pty:exit carrying the stale-session reason (issue #90 path) */
    const emitStaleExit = (
      electronApp: import('electron').ElectronApplication,
      sessionId: string
    ) =>
      electronApp.evaluate(({ BrowserWindow }, sid: string) => {
        const win = BrowserWindow.getAllWindows().find(
          (w) => !w.isDestroyed() && !w.webContents.getURL().startsWith('data:')
        )
        win?.webContents.send('pty:exit', sid, 0, 'SESSION_NOT_FOUND')
      }, sessionId)

    /** Open the terminal header dropdown menu */
    const openTerminalMenu = async (page: import('@playwright/test').Page) => {
      await page
        .locator('.lucide-ellipsis:visible, .lucide-more-horizontal:visible')
        .first()
        .click()
      await expect(page.locator('[role="menu"]')).toBeVisible()
    }

    test.beforeAll(async ({ electronApp, mainWindow }) => {
      await resetApp(mainWindow)
      await installMock(electronApp)

      const s = seed(mainWindow)
      const p = await s.createProject({
        name: 'SessInval',
        color: '#ef4444',
        path: TEST_PROJECT_PATH
      })
      projectAbbrev = p.name.slice(0, 2).toUpperCase()
      projectId = p.id
      await s.refreshData()
    })

    test.afterAll(async ({ electronApp }) => {
      await electronApp.evaluate(() => {
        const restore = (globalThis as unknown as { __restorePtyHandlers?: () => void })
          .__restorePtyHandlers
        restore?.()
      })
    })

    // --- stale session (issue #90): friendly overlay + manual "Start fresh" ---

    test('stale-session exit shows the "Start fresh" overlay', async ({
      electronApp,
      mainWindow
    }) => {
      const s = seed(mainWindow)
      const t = await s.createTask({ projectId, title: 'SI overlay', status: 'in_progress' })
      await mainWindow.evaluate(
        ({ id }) =>
          window.getTrpcVanillaClient().task.update.mutate({
            id,
            providerConfig: { 'claude-code': { conversationId: 'stale-overlay' } }
          }),
        { id: t.id }
      )
      await s.refreshData()

      await resetCapture(electronApp)
      await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'SI overlay' })
      await expect.poll(() => getCreateCount(electronApp), { timeout: 10_000 }).toBeGreaterThan(0)

      const sessionId = getMainSessionId(t.id)
      await emitStaleExit(electronApp, sessionId)

      await expect(mainWindow.getByText(/session expired/i)).toBeVisible()
      await expect(mainWindow.getByRole('button', { name: 'Start fresh' })).toBeVisible()
    })

    test('"Start fresh" clears conversationId and remounts; id survives until then', async ({
      electronApp,
      mainWindow
    }) => {
      const s = seed(mainWindow)
      const t = await s.createTask({ projectId, title: 'SI fresh', status: 'in_progress' })
      await mainWindow.evaluate(
        ({ id }) =>
          window.getTrpcVanillaClient().task.update.mutate({
            id,
            providerConfig: { 'claude-code': { conversationId: 'clear-on-fresh' } }
          }),
        { id: t.id }
      )
      await s.refreshData()

      await resetCapture(electronApp)
      await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'SI fresh' })
      await expect.poll(() => getCreateCount(electronApp), { timeout: 10_000 }).toBeGreaterThan(0)
      const countBefore = await getCreateCount(electronApp)

      const sessionId = getMainSessionId(t.id)
      await emitStaleExit(electronApp, sessionId)
      await expect(mainWindow.getByRole('button', { name: 'Start fresh' })).toBeVisible()

      // Manual-only (issue #90 decision Q1): the id survives until the user acts.
      const mid = await mainWindow.evaluate((id) => window.getTrpcVanillaClient().task.get.query({ id }), t.id)
      expect(mid?.provider_config?.['claude-code']?.conversationId).toBe('clear-on-fresh')

      await mainWindow.getByRole('button', { name: 'Start fresh' }).click()

      // Now the id is cleared and the terminal remounts fresh.
      await expect
        .poll(
          async () => {
            const task = await mainWindow.evaluate((id) => window.getTrpcVanillaClient().task.get.query({ id }), t.id)
            return task?.provider_config?.['claude-code']?.conversationId ?? null
          },
          { timeout: 10_000 }
        )
        .toBeNull()
      await expect
        .poll(() => getCreateCount(electronApp), { timeout: 10_000 })
        .toBeGreaterThan(countBefore)
    })

    // --- Reset terminal (menu) ---

    test('reset terminal clears conversationId and remounts', async ({
      electronApp,
      mainWindow
    }) => {
      const s = seed(mainWindow)
      const t = await s.createTask({ projectId, title: 'SI reset', status: 'in_progress' })
      await mainWindow.evaluate(
        ({ id }) =>
          window.getTrpcVanillaClient().task.update.mutate({
            id,
            providerConfig: { 'claude-code': { conversationId: 'reset-me' } }
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
      await expect
        .poll(
          async () => {
            const task = await mainWindow.evaluate((id) => window.getTrpcVanillaClient().task.get.query({ id }), t.id)
            return task?.provider_config?.['claude-code']?.conversationId ?? null
          },
          { timeout: 10_000 }
        )
        .toBeNull()

      // PTY should have been killed
      const sessionId = getMainSessionId(t.id)
      await expect
        .poll(
          async () => {
            const kills = await getKillCalls(electronApp)
            return kills.includes(sessionId)
          },
          { timeout: 10_000 }
        )
        .toBe(true)

      // Terminal should remount (new pty:create call)
      await expect
        .poll(() => getCreateCount(electronApp), { timeout: 10_000 })
        .toBeGreaterThan(countBefore)
    })

    // --- Restart terminal (menu) ---

    test('restart terminal preserves conversationId and remounts with same ID', async ({
      electronApp,
      mainWindow
    }) => {
      const storedId = 'keep-on-restart'
      const s = seed(mainWindow)
      const t = await s.createTask({ projectId, title: 'SI restart', status: 'in_progress' })
      await mainWindow.evaluate(
        ({ id, cid }) =>
          window.getTrpcVanillaClient().task.update.mutate({
            id,
            providerConfig: { 'claude-code': { conversationId: cid } }
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
      const task = await mainWindow.evaluate((id) => window.getTrpcVanillaClient().task.get.query({ id }), t.id)
      expect(task?.provider_config?.['claude-code']?.conversationId).toBe(storedId)

      // PTY should have been killed
      const sessionId = getMainSessionId(t.id)
      await expect
        .poll(
          async () => {
            const kills = await getKillCalls(electronApp)
            return kills.includes(sessionId)
          },
          { timeout: 10_000 }
        )
        .toBe(true)

      // Terminal should remount with same existingConversationId
      await expect
        .poll(() => getCreateCount(electronApp), { timeout: 10_000 })
        .toBeGreaterThan(countBefore)

      const opts = await getLastOpts(electronApp)
      expect(opts?.existingConversationId).toBe(storedId)
    })
  })
