import { test, expect, clickSettings, resetApp } from '../fixtures/electron'

/**
 * Runner settings tab (inside the Connections settings tab).
 *
 * Smoke-level guard that the "Runners" section renders with enrollment ALWAYS
 * available — a hub always accepts runners, so there is no enable-toggle and no
 * boot-gate. The "Add a runner" control is enabled from the start; the old
 * enable-mode toggle + its disabled-until-booted explainer are gone.
 */
test.describe('Runner settings tab', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  const openRunnersTab = async (mainWindow: import('@playwright/test').Page) => {
    // Target the Settings dialog EXPLICITLY — the same selector `clickSettings`
    // waits on. `getByRole('dialog').last()` is not reliably the settings surface
    // once this file opens a second dialog (the restart confirm below).
    const dialog = mainWindow.locator('[role="dialog"][aria-label="Settings"]').first()
    const connections = dialog.locator('aside button').filter({ hasText: 'Connections' }).first()
    // Open AND navigate as one retried unit. A preceding test ends by pressing
    // Escape, so this can arrive while the dialog is mid-close: a visibility
    // snapshot then reads "open", the reopen is skipped, and the click resolves
    // against a dialog that is already gone — a 30s timeout with nothing in the
    // trace to explain it. `clickSettings` no-ops when already open, so retrying
    // the whole sequence is safe.
    await expect(async () => {
      await clickSettings(mainWindow)
      await expect(dialog).toBeVisible({ timeout: 2_000 })
      await connections.click({ timeout: 2_000 })
    }).toPass({ timeout: 20_000 })
    // The enroll form lives in a collapsed "＋ Add new runner" row now — expand it
    // (idempotent: the dialog persists across tests, so only click when the
    // collapsed opener is still showing).
    const opener = dialog.getByTestId('runner-add-open')
    if (await opener.isVisible().catch(() => false)) await opener.click()
    await expect(dialog.getByTestId('runner-add')).toBeVisible({ timeout: 5_000 })
    return dialog
  }

  test('renders the Runners section with enrollment always available (no toggle)', async ({
    mainWindow
  }) => {
    const dialog = await openRunnersTab(mainWindow)

    // Enrollment is always on — the Add button is enabled once the row expands.
    await expect(dialog.getByTestId('runner-add')).toBeEnabled()

    // The old enable-mode toggle + its disabled-until-booted explainer are gone.
    await expect(dialog.getByTestId('runners-enabled-toggle')).toHaveCount(0)
    await expect(dialog.getByTestId('runner-enroll-disabled')).toHaveCount(0)

    await mainWindow.keyboard.press('Escape')
  })

  /**
   * The local runner is the app's own supervised child, so its row carries a
   * restart action — the only recovery from the supervisor's dead ends
   * (needs-re-enrollment, exhausted backoff) short of relaunching the app.
   *
   * This deliberately stops at the confirm dialog. Actually restarting would kill
   * every agent pty on the machine, including the ones the rest of this suite
   * runs in.
   */
  test('offers a confirm-gated restart for the local runner', async ({ mainWindow }) => {
    const dialog = await openRunnersTab(mainWindow)

    // The local hub either HAS its runner (→ restart) or is missing it (→ start),
    // never neither. Which one shows depends on how far auto-enroll has got, so
    // accept both rather than racing enrollment.
    const restart = dialog.getByTestId('runner-local-restart')
    const start = dialog.getByTestId('runner-local-start')
    await expect
      .poll(async () => (await restart.count()) + (await start.count()), { timeout: 30_000 })
      .toBeGreaterThan(0)

    if ((await restart.count()) > 0) {
      // Enrolled: restart must be CONFIRM-GATED. Open the confirm and cancel —
      // actually restarting would kill the terminals the rest of the suite uses.
      await restart.first().click()
      // The confirm renders in its own portal, so it is not inside the settings
      // dialog's subtree — query from the window.
      await expect(mainWindow.getByTestId('runner-local-restart-confirm')).toBeVisible({
        timeout: 5_000
      })
      await mainWindow.keyboard.press('Escape')
      await expect(mainWindow.getByTestId('runner-local-restart-confirm')).toHaveCount(0, {
        timeout: 5_000
      })
    } else {
      // Auto-enroll has not landed yet, so the row is the "not running" one. Its
      // Start control must be live — that state is exactly when the user needs it.
      // Deliberately NOT clicked: spawning a runner mid-suite is not this spec's
      // business.
      await expect(start.first()).toBeEnabled()
    }

    await mainWindow.keyboard.press('Escape')
  })
})
