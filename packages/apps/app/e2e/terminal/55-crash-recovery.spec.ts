/**
 * Terminal crash recovery — overlay UI + Doctor validation.
 *
 * Crash overlay tests use a custom AI-labelled mode with no initial command.
 * The PTY starts as a plain shell, then the test explicitly exits that shell
 * non-zero to drive the renderer into the dead-overlay state.
 *
 * Doctor-menu tests use `claude-code` (binary must be installed).
 */
import { test, expect, seed, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH, goHome, clickProject } from '../fixtures/electron'
import {
  getMainSessionId,
  openTaskTerminal,
  runCommand,
  switchTerminalMode,
  waitForBufferContains,
  waitForPtySession
} from '../fixtures/terminal'
const crashModeId = 'crash-overlay-e2e'

// ─── Crash overlay ────────────────────────────────────────────────────────────

test.describe('Terminal crash overlay', () => {
    let projectAbbrev: string
    let taskId: string
    let sessionId: string

    test.beforeAll(async ({ mainWindow }) => {
      await resetApp(mainWindow)
      // AI-mode terminals are idle-gated (TerminalStarter). The custom mode's
      // starter button ("Open Crash Overlay E2E") doesn't match
      // startAgentTerminal's built-in-agent regex, and every Retry remount
      // would re-hit the gate anyway (exit clears `was_spawned`) — seed
      // auto-start so mounts spawn directly. The gate is 93/97's subject.
      await mainWindow.evaluate(() =>
        window.getTrpcVanillaClient().settings.set.mutate({ key: 'terminal_auto_start', value: '1' })
      )
      await mainWindow.evaluate(
        (id) =>
          window.getTrpcVanillaClient().pty.modesCreate.mutate({
            id,
            label: 'Crash Overlay E2E',
            type: 'claude-code',
            initialCommand: null,
            resumeCommand: null,
            defaultFlags: '',
            enabled: true,
            order: 999
          }),
        crashModeId
      )
      const s = seed(mainWindow)
      const p = await s.createProject({
        name: 'CrashRec',
        color: '#dc2626',
        path: TEST_PROJECT_PATH
      })
      projectAbbrev = p.name.slice(0, 2).toUpperCase()

      const t = await s.createTask({
        projectId: p.id,
        title: 'Crash overlay task',
        status: 'in_progress'
      })
      taskId = t.id
      sessionId = getMainSessionId(taskId)

      // Set the task to the custom mode and open its terminal.
      await mainWindow.evaluate(
        ({ id, m }) => window.getTrpcVanillaClient().task.update.mutate({ id, terminalMode: m }),
        {
          id: taskId,
          m: crashModeId
        }
      )
      await s.refreshData()

      await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Crash overlay task' })
      await waitForPtySession(mainWindow, sessionId)
    })

    test.afterAll(async ({ mainWindow }) => {
      await mainWindow.evaluate(
        (id) => window.getTrpcVanillaClient().pty.modesDelete.mutate({ id }),
        crashModeId
      )
      await mainWindow
        .evaluate(() =>
          window
            .getTrpcVanillaClient()
            .settings.set.mutate({ key: 'terminal_auto_start', value: '0' })
        )
        .catch(() => {})
    })

    const ensureLiveTerminal = async (mainWindow: import('@playwright/test').Page) => {
      const retryButton = mainWindow.getByRole('button', { name: 'Retry' }).last()
      if (await retryButton.isVisible({ timeout: 500 }).catch(() => false)) {
        await retryButton.click()
        await expect(retryButton).not.toBeVisible({ timeout: 3_000 })
      }
      await waitForPtySession(mainWindow, sessionId)
    }

    const crashTerminal = async (mainWindow: import('@playwright/test').Page) => {
      await ensureLiveTerminal(mainWindow)
      // Readiness gate: the session registers before the shell finishes its
      // startup, so an immediate `exit 7` can land while the shell isn't
      // processing input yet (flaky overlay). Prove the shell is live with an
      // echo round-trip first.
      const ready = `CRASH_READY_${Date.now()}`
      await runCommand(mainWindow, sessionId, `echo ${ready}`)
      await waitForBufferContains(mainWindow, sessionId, ready)
      await runCommand(mainWindow, sessionId, 'exit 7')
    }

    test('overlay appears after terminal crash', async ({ mainWindow }) => {
      await crashTerminal(mainWindow)
      await expect(mainWindow.getByText(/Process exited with code/i).last()).toBeVisible({
        timeout: 10_000
      })
    })

    test('overlay shows Retry and Doctor buttons', async ({ mainWindow }) => {
      await crashTerminal(mainWindow)

      await expect(mainWindow.getByRole('button', { name: 'Retry' }).last()).toBeVisible({
        timeout: 10_000
      })

      await expect(mainWindow.getByRole('button', { name: 'Doctor' }).last()).toBeVisible({
        timeout: 10_000
      })
    })

    test('Doctor from overlay shows validation results', async ({ mainWindow }) => {
      await crashTerminal(mainWindow)
      await mainWindow.getByRole('button', { name: 'Doctor' }).last().click()

      // Results should appear inline in the overlay.
      await expect(mainWindow.locator('text=/Binary found|Shell detected/i').first()).toBeVisible({
        timeout: 8_000
      })

      // Doctor cards render structured check output.
      await expect(mainWindow.locator('.rounded-lg.border:visible').first()).toBeVisible({
        timeout: 3_000
      })
    })

    test('Retry clears overlay then it reappears after re-crash', async ({ mainWindow }) => {
      await crashTerminal(mainWindow)
      const exitText = mainWindow.getByText(/Process exited with code/i).last()
      await expect(exitText).toBeVisible()

      await mainWindow.getByRole('button', { name: 'Retry' }).last().click()

      // Overlay clears immediately after Retry
      await expect(exitText).not.toBeVisible({ timeout: 3_000 })

      await waitForPtySession(mainWindow, sessionId)
      await crashTerminal(mainWindow)

      // Terminal respawns, then we force a second crash and the overlay reappears.
      await expect(mainWindow.getByText(/Process exited with code/i).last()).toBeVisible({
        timeout: 10_000
      })
    })
  })

// ─── Doctor from three-dots menu ─────────────────────────────────────────────

test.describe('Doctor from terminal menu', () => {
  let projectAbbrev: string
  let taskId: string
  const terminalMenuButton = (mainWindow: import('@playwright/test').Page) =>
    mainWindow.locator('[data-testid="terminal-menu-trigger"]:visible').first()
  const doctorMenuItem = (mainWindow: import('@playwright/test').Page) =>
    mainWindow.getByRole('menuitem', { name: 'Doctor' })
  const openTerminalMenu = async (mainWindow: import('@playwright/test').Page) => {
    await mainWindow.keyboard.press('Escape').catch(() => {})
    await terminalMenuButton(mainWindow).click()
  }
  const setTerminalMode = async (
    mainWindow: import('@playwright/test').Page,
    mode: 'claude-code' | 'terminal'
  ) => {
    // ContextMenu fixture is flaky in Playwright for non-'terminal' modes
    // (see 22 quarantine). Bypass via DB write — the renderer re-renders
    // the mode trigger on tasks:changed, which is what these tests probe.
    if (mode === 'claude-code') {
      await mainWindow.evaluate(
        (id) => window.getTrpcVanillaClient().task.update.mutate({ id, terminalMode: 'claude-code' }),
        taskId
      )
      await mainWindow.evaluate(() => {
        const refresh = (window as { __slayzone_refreshData?: () => Promise<void> | void })
          .__slayzone_refreshData
        return refresh?.()
      })
      // Give the renderer a beat to reflect the mode change before the next
      // step opens a menu that depends on terminal_mode.
      await mainWindow.waitForTimeout(150)
    } else {
      await switchTerminalMode(mainWindow, mode)
    }
  }

  test.beforeAll(async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'DocMenu',
      color: '#2563eb',
      path: TEST_PROJECT_PATH
    })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()

    const t = await s.createTask({
      projectId: p.id,
      title: 'Doctor menu task',
      status: 'in_progress'
    })
    taskId = t.id

    // Keep default claude-code mode
    await s.refreshData()
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Doctor menu task' })
  })

  test('Doctor menu item is present for AI modes', async ({ mainWindow }) => {
    // Wait for terminal menu button to be visible (PTY may still be initializing)
    await expect(terminalMenuButton(mainWindow)).toBeVisible({ timeout: 10_000 })
    // Open the three-dots menu
    await openTerminalMenu(mainWindow)

    await expect(doctorMenuItem(mainWindow)).toBeVisible({ timeout: 3_000 })

    // Close the menu
    await mainWindow.keyboard.press('Escape')
  })

  test('Doctor dialog shows validation results for claude', async ({ mainWindow }) => {
    await setTerminalMode(mainWindow, 'claude-code')
    await openTerminalMenu(mainWindow)
    await expect(doctorMenuItem(mainWindow)).toBeVisible({ timeout: 3_000 })

    await doctorMenuItem(mainWindow).click()

    // Dialog should open
    const dialog = mainWindow.locator('[role="dialog"]:visible').last()
    await expect(dialog).toBeVisible({ timeout: 3_000 })
    await expect(dialog).toContainText(/Environment check|Doctor/, { timeout: 2_000 })

    // Should show at least one check result
    await expect(dialog.locator('text=/Binary found/i').first()).toBeVisible({ timeout: 8_000 })

    // claude is installed → check should report binary found path
    await expect(dialog.getByText(/Binary found/i).first()).toBeVisible({ timeout: 3_000 })

    // Close
    await mainWindow.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible({ timeout: 2_000 })
  })

  test('Doctor not shown for terminal mode', async ({ mainWindow }) => {
    // Switch to terminal mode via UI to ensure rendered state is up to date.
    await setTerminalMode(mainWindow, 'terminal')

    await openTerminalMenu(mainWindow)

    await expect(doctorMenuItem(mainWindow)).not.toBeVisible({ timeout: 2_000 })

    await mainWindow.keyboard.press('Escape')

    // Restore to claude-code
    await setTerminalMode(mainWindow, 'claude-code')
  })
})
