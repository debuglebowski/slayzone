import { test, expect, seed, resetApp, proveConversationTurn } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  openTaskTerminal,
  startAgentTerminal,
  getMainSessionId,
  closeAllTaskTabs,
  seedSession,
  currentSession
} from '../fixtures/terminal'

/**
 * Tests stale-session handling (issue #90: provider auto-cleaned the session),
 * reset terminal, and restart terminal — without real CLIs.
 *
 * Migrated 2026-07-03 off the legacy ipcMain pty:create/kill/exists mocks (orphaned
 * by the slice-9 sidecar cutover) onto the sidecar-side createPty capture:
 * `pty.testSetPtyCreateCapture` stubs the spawn chokepoint and records create opts
 * (`testTakePtyCreateOpts`) + kill calls (`testTakePtyKillCalls`). AI terminals are
 * idle-gated, so each open clicks the "Open <agent>" starter (startAgentTerminal).
 *
 * Stale detection rides the `pty:exit` reason (code SESSION_NOT_FOUND); the spec
 * drives it via the PLAYWRIGHT-gated `pty.testEmitExit` (no real process exists
 * under the capture stub). There is no auto-clear — the dead overlay shows a
 * friendly message and recovery is the user-initiated "Start fresh" button.
 */
test.describe('Session invalidation', () => {
  let projectAbbrev: string
  let projectId: string

  /** Enable (and clear) the sidecar createPty capture — stubs the spawn. */
  const resetCapture = (mainWindow: import('@playwright/test').Page) =>
    mainWindow.evaluate(() =>
      window.getTrpcVanillaClient().pty.testSetPtyCreateCapture.mutate({ enabled: true })
    )

  /** Captured pty.create calls for one session (capture records every spawn path). */
  const getCreateCount = (mainWindow: import('@playwright/test').Page, sessionId: string) =>
    mainWindow.evaluate(async (sid) => {
      const all = (await window.getTrpcVanillaClient().pty.testTakePtyCreateOpts.query()) as Array<{
        sessionId: string
      }>
      return all.filter((o) => o.sessionId === sid).length
    }, sessionId)

  const getKillCalls = (mainWindow: import('@playwright/test').Page) =>
    mainWindow.evaluate(
      () => window.getTrpcVanillaClient().pty.testTakePtyKillCalls.query() as Promise<string[]>
    )

  const getLastOpts = (mainWindow: import('@playwright/test').Page, sessionId: string) =>
    mainWindow.evaluate(async (sid) => {
      const all = (await window.getTrpcVanillaClient().pty.testTakePtyCreateOpts.query()) as Array<{
        sessionId: string
      }>
      const mine = all.filter((o) => o.sessionId === sid)
      return mine[mine.length - 1] ?? null
    }, sessionId) as Promise<{
      existingConversationId?: string | null
      /** What the spawn resumes (the ledger's, on the computer). */
      resumeConversationId?: string | null
      mode?: string
    } | null>

  /** Emit pty:exit carrying the stale-session reason (issue #90 path) */
  const emitStaleExit = (mainWindow: import('@playwright/test').Page, sessionId: string) =>
    mainWindow.evaluate(
      (sid) =>
        window.getTrpcVanillaClient().pty.testEmitExit.mutate({
          sessionId: sid,
          exitCode: 0,
          errorCode: 'SESSION_NOT_FOUND'
        }),
      sessionId
    )

  /** Open the terminal header dropdown menu */
  const openTerminalMenu = async (page: import('@playwright/test').Page) => {
    await page.locator('[data-testid="terminal-menu-trigger"]:visible').last().click()
    await expect(page.locator('[role="menu"]')).toBeVisible()
  }

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    // `instant` startup mode: the reset/restart/"Start fresh" remounts under test
    // re-check the idle-gate, and the capture stub never records
    // `terminal_tabs.agent_state = 'running'` (that write lives after the real
    // spawn), so otherwise the gate would re-appear mid-test and swallow the
    // remount's pty.create. The gate itself is 93/97's subject, not this spec's.
    await mainWindow.evaluate(() =>
      window
        .getTrpcVanillaClient()
        .settings.set.mutate({ key: 'terminal_agent_startup', value: 'instant' })
    )
    await resetCapture(mainWindow)

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

  // Per-test terminal teardown: serial AI-mode opens otherwise accumulate
  // hidden mounted terminals that destabilize the shared createPty capture
  // for later tests.
  test.afterEach(async ({ mainWindow }) => {
    await closeAllTaskTabs(mainWindow)
  })

  test.afterAll(async ({ mainWindow }) => {
    await mainWindow.evaluate(() =>
      window.getTrpcVanillaClient().pty.testSetPtyCreateCapture.mutate({ enabled: false })
    )
  })

  // --- stale session (issue #90): friendly overlay + manual "Start fresh" ---

  test('stale-session exit shows the "Start fresh" overlay', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const t = await s.createTask({ projectId, title: 'SI overlay', status: 'in_progress' })
    await seedSession(mainWindow, t.id, 'claude-code', 'stale-overlay')
    await proveConversationTurn(mainWindow, t.id, 'stale-overlay')
    await s.refreshData()

    const sessionId = getMainSessionId(t.id)
    await resetCapture(mainWindow)
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'SI overlay' })
    await startAgentTerminal(mainWindow)
    await expect
      .poll(() => getCreateCount(mainWindow, sessionId), { timeout: 10_000 })
      .toBeGreaterThan(0)

    await emitStaleExit(mainWindow, sessionId)

    await expect(mainWindow.getByText(/session expired/i)).toBeVisible()
    await expect(mainWindow.getByRole('button', { name: 'Start fresh' })).toBeVisible()
  })

  test('"Start fresh" clears conversationId and remounts; id survives until then', async ({
    mainWindow
  }) => {
    const s = seed(mainWindow)
    const t = await s.createTask({ projectId, title: 'SI fresh', status: 'in_progress' })
    await seedSession(mainWindow, t.id, 'claude-code', 'clear-on-fresh')
    await proveConversationTurn(mainWindow, t.id, 'clear-on-fresh')
    await s.refreshData()

    const sessionId = getMainSessionId(t.id)
    await resetCapture(mainWindow)
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'SI fresh' })
    await startAgentTerminal(mainWindow)
    await expect
      .poll(() => getCreateCount(mainWindow, sessionId), { timeout: 10_000 })
      .toBeGreaterThan(0)
    const countBefore = await getCreateCount(mainWindow, sessionId)

    await emitStaleExit(mainWindow, sessionId)
    await expect(mainWindow.getByRole('button', { name: 'Start fresh' })).toBeVisible()

    // Manual-only (issue #90 decision Q1): the id survives until the user acts.
    expect(await currentSession(mainWindow, t.id, 'claude-code')).toBe('clear-on-fresh')

    await mainWindow.getByRole('button', { name: 'Start fresh' }).click()

    // Now the id is cleared and the terminal remounts fresh.
    await expect
      .poll(
        async () => {
          return currentSession(mainWindow, t.id, 'claude-code')
        },
        { timeout: 10_000 }
      )
      .toBeNull()
    await expect
      .poll(() => getCreateCount(mainWindow, sessionId), { timeout: 10_000 })
      .toBeGreaterThan(countBefore)
  })

  // --- Reset terminal (menu) ---

  test('reset terminal clears conversationId and remounts', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const t = await s.createTask({ projectId, title: 'SI reset', status: 'in_progress' })
    await seedSession(mainWindow, t.id, 'claude-code', 'reset-me')
    await proveConversationTurn(mainWindow, t.id, 'reset-me')
    await s.refreshData()

    const sessionId = getMainSessionId(t.id)
    await resetCapture(mainWindow)
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'SI reset' })
    await startAgentTerminal(mainWindow)
    await expect
      .poll(() => getCreateCount(mainWindow, sessionId), { timeout: 10_000 })
      .toBeGreaterThan(0)

    const countBefore = await getCreateCount(mainWindow, sessionId)

    // Click "Reset session" in dropdown menu
    await openTerminalMenu(mainWindow)
    await mainWindow.getByRole('menuitem', { name: 'Reset session' }).click()

    // conversationId should be cleared
    await expect
      .poll(
        async () => {
          return currentSession(mainWindow, t.id, 'claude-code')
        },
        { timeout: 10_000 }
      )
      .toBeNull()

    // PTY should have been killed
    await expect
      .poll(
        async () => {
          const kills = await getKillCalls(mainWindow)
          return kills.includes(sessionId)
        },
        { timeout: 10_000 }
      )
      .toBe(true)

    // Terminal should remount (new pty:create call)
    await expect
      .poll(() => getCreateCount(mainWindow, sessionId), { timeout: 10_000 })
      .toBeGreaterThan(countBefore)
  })

  // --- Restart terminal (menu) ---

  test('restart terminal preserves conversationId and remounts with same ID', async ({
    mainWindow
  }) => {
    const storedId = 'keep-on-restart'
    const s = seed(mainWindow)
    const t = await s.createTask({ projectId, title: 'SI restart', status: 'in_progress' })
    await seedSession(mainWindow, t.id, 'claude-code', storedId)
    await proveConversationTurn(mainWindow, t.id, storedId)
    await s.refreshData()

    const sessionId = getMainSessionId(t.id)
    await resetCapture(mainWindow)
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'SI restart' })
    await startAgentTerminal(mainWindow)
    await expect
      .poll(() => getCreateCount(mainWindow, sessionId), { timeout: 10_000 })
      .toBeGreaterThan(0)

    const countBefore = await getCreateCount(mainWindow, sessionId)

    // Click "Restart session" in dropdown menu
    await openTerminalMenu(mainWindow)
    await mainWindow.getByRole('menuitem', { name: 'Restart session' }).click()

    // conversationId should be PRESERVED
    expect(await currentSession(mainWindow, t.id, 'claude-code')).toBe(storedId)

    // PTY should have been killed
    await expect
      .poll(
        async () => {
          const kills = await getKillCalls(mainWindow)
          return kills.includes(sessionId)
        },
        { timeout: 10_000 }
      )
      .toBe(true)

    // Terminal should remount resuming the same conversation
    await expect
      .poll(() => getCreateCount(mainWindow, sessionId), { timeout: 10_000 })
      .toBeGreaterThan(countBefore)

    const opts = await getLastOpts(mainWindow, sessionId)
    expect(opts?.resumeConversationId).toBe(storedId)
  })
})
