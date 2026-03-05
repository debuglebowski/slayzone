/**
 * Terminal crash recovery — overlay UI + Doctor validation.
 *
 * Crash overlay tests use a mode whose binary is NOT installed so the PTY
 * exits immediately (exitCode ≠ 0) and the dead overlay appears.
 * We prefer `cursor-agent` since it's the least likely to be installed.
 * If it IS installed, we fall back to `gemini`, then skip if both present.
 *
 * Doctor-menu tests use `claude-code` (binary must be installed).
 */
import { test, expect, seed } from './fixtures/electron'
import { TEST_PROJECT_PATH, goHome, clickProject } from './fixtures/electron'
import {
  openTaskTerminal,
  binaryOnPath,
  switchTerminalMode,
} from './fixtures/terminal'
import type { TerminalMode } from '@slayzone/terminal/shared'

// Pick a mode whose binary is guaranteed absent — overlay can then be tested.
function pickAbsentMode(): TerminalMode | null {
  if (!binaryOnPath('cursor-agent')) return 'cursor-agent'
  if (!binaryOnPath('gemini')) return 'gemini'
  if (!binaryOnPath('opencode')) return 'opencode'
  return null
}

const absentMode = pickAbsentMode()
const hasClaude = binaryOnPath('claude')

// ─── Crash overlay ────────────────────────────────────────────────────────────

test.describe('Terminal crash overlay', () => {
  test.skip(!absentMode, 'All AI mode binaries are installed — cannot test crash overlay')

  let projectAbbrev: string
  let taskId: string
  const mode = absentMode! // narrowed by skip above

  test.beforeAll(async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'CrashRec',
      color: '#dc2626',
      path: TEST_PROJECT_PATH,
    })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()

    const t = await s.createTask({
      projectId: p.id,
      title: 'Crash overlay task',
      status: 'in_progress',
    })
    taskId = t.id

    // Set the task to a mode whose binary is absent
    await mainWindow.evaluate(
      ({ id, m }) => window.api.db.updateTask({ id, terminalMode: m }),
      { id: taskId, m: mode }
    )
    await s.refreshData()

    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Crash overlay task' })
  })

  test('overlay appears after terminal crash', async ({ mainWindow }) => {
    // The overlay text is the most reliable signal — it renders when
    // ptyState === 'dead' in the renderer (frontend PtyContext state).
    // We don't poll window.api.pty.getState because the backend session
    // is deleted ~200ms after exit, making the 'dead' window very narrow.
    await expect(
      mainWindow.getByText(/Process exited with code/i).last()
    ).toBeVisible({ timeout: 10_000 })
  })

  test('overlay shows Retry and Doctor buttons', async ({ mainWindow }) => {
    await expect(
      mainWindow.getByRole('button', { name: 'Retry' }).last()
    ).toBeVisible({ timeout: 3_000 })

    await expect(
      mainWindow.getByRole('button', { name: 'Doctor' }).last()
    ).toBeVisible({ timeout: 3_000 })
  })

  test('Doctor from overlay shows validation results', async ({ mainWindow }) => {
    await mainWindow.getByRole('button', { name: 'Doctor' }).last().click()

    // Results should appear inline in the overlay — binary not found
    await expect(
      mainWindow.getByText(/not found in PATH/i).last()
    ).toBeVisible({ timeout: 8_000 })

    // Fix instructions (font-mono install command) should be visible
    await expect(
      mainWindow.locator('.font-mono:visible').last()
    ).toBeVisible({ timeout: 3_000 })
  })

  test('Retry clears overlay then it reappears after re-crash', async ({ mainWindow }) => {
    const exitText = mainWindow.getByText(/Process exited with code/i).last()
    await expect(exitText).toBeVisible()

    await mainWindow.getByRole('button', { name: 'Retry' }).last().click()

    // Overlay clears immediately after Retry
    await expect(exitText).not.toBeVisible({ timeout: 3_000 })

    // Terminal respawns → crashes again → overlay reappears
    await expect(
      mainWindow.getByText(/Process exited with code/i).last()
    ).toBeVisible({ timeout: 10_000 })
  })
})

// ─── Doctor from three-dots menu ─────────────────────────────────────────────

test.describe('Doctor from terminal menu', () => {
  test.skip(!hasClaude, 'claude binary not found — skipping doctor menu test')

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
    await switchTerminalMode(mainWindow, mode)
  }

  test.beforeAll(async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'DocMenu',
      color: '#2563eb',
      path: TEST_PROJECT_PATH,
    })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()

    const t = await s.createTask({
      projectId: p.id,
      title: 'Doctor menu task',
      status: 'in_progress',
    })
    taskId = t.id

    // Keep default claude-code mode
    await s.refreshData()
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Doctor menu task' })
  })

  test('Doctor menu item is present for AI modes', async ({ mainWindow }) => {
    // Open the three-dots menu
    await openTerminalMenu(mainWindow)

    await expect(
      doctorMenuItem(mainWindow)
    ).toBeVisible({ timeout: 3_000 })

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
    await expect(
      dialog.locator('text=/Binary found/i').first()
    ).toBeVisible({ timeout: 8_000 })

    // claude is installed → check should report binary found path
    await expect(
      dialog.getByText(/Binary found/i).first()
    ).toBeVisible({ timeout: 3_000 })

    // Close
    await mainWindow.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible({ timeout: 2_000 })
  })

  test('Doctor not shown for terminal mode', async ({ mainWindow }) => {
    // Switch to terminal mode via UI to ensure rendered state is up to date.
    await setTerminalMode(mainWindow, 'terminal')

    await openTerminalMenu(mainWindow)

    await expect(
      doctorMenuItem(mainWindow)
    ).not.toBeVisible({ timeout: 2_000 })

    await mainWindow.keyboard.press('Escape')

    // Restore to claude-code
    await setTerminalMode(mainWindow, 'claude-code')
  })
})
