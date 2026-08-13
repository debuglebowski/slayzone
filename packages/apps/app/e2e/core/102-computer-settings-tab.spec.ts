import { test, expect, clickSettings, resetApp } from '../fixtures/electron'

/**
 * Computer settings for the LOCAL hub (nested inside its card, in Connections).
 *
 * The local hub is a special case and this spec pins the two ways it differs from
 * a remote one:
 *
 *  - it does NOT enroll. A token minted against a loopback address is redeemable
 *    only by something already on this machine, where the supervised computer
 *    already is — so there is no add leaf here at all.
 *  - its computer is NOT revocable, but IS restartable. It is the app's own child
 *    process; revoking would delete the credential it re-dials with, while
 *    restarting is the recovery from the supervisor's dead ends.
 *
 * Everything is scoped to the local hub's card: these testids appear once per
 * connected hub, so an unscoped lookup goes ambiguous the moment a second hub is
 * configured.
 */
test.describe('Computer settings tab', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  const openComputersTab = async (mainWindow: import('@playwright/test').Page) => {
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
    // The local hub's card — computers are nested inside their hub, so scope to it.
    const group = dialog.getByTestId('hub-group-local')
    await expect(group).toBeVisible({ timeout: 10_000 })
    await expect(group.getByTestId('computers-table')).toBeVisible({ timeout: 10_000 })
    return group
  }

  test('the local hub lists computers but offers no way to enroll one', async ({ mainWindow }) => {
    const group = await openComputersTab(mainWindow)

    // No add leaf, and therefore no enroll form to reach.
    await expect(group.getByTestId('computer-add-open')).toHaveCount(0)
    await expect(group.getByTestId('computer-add-row')).toHaveCount(0)
    await expect(group.getByTestId('computer-add')).toHaveCount(0)

    // The old enable-mode toggle + its disabled-until-booted explainer are gone.
    await expect(group.getByTestId('computers-enabled-toggle')).toHaveCount(0)
    await expect(group.getByTestId('computer-enroll-disabled')).toHaveCount(0)

    await mainWindow.keyboard.press('Escape')
  })

  test('the local computer cannot be revoked', async ({ mainWindow }) => {
    const group = await openComputersTab(mainWindow)

    // Either the computer is enrolled (a row, no revoke on it) or it is missing (the
    // Start row). Neither state offers a revoke, because the only computer the local
    // hub can have is the one this app supervises.
    await expect
      .poll(
        async () =>
          (await group.getByTestId('computer-row').count()) +
          (await group.getByTestId('computer-local-missing').count()),
        { timeout: 30_000 }
      )
      .toBeGreaterThan(0)
    await expect(group.getByTestId('computer-revoke')).toHaveCount(0)

    await mainWindow.keyboard.press('Escape')
  })

  /**
   * The local computer is the app's own supervised child, so its row carries a
   * restart action — the only recovery from the supervisor's dead ends
   * (needs-re-enrollment, exhausted backoff) short of relaunching the app.
   *
   * This deliberately stops at the confirm dialog. Actually restarting would kill
   * every agent pty on the machine, including the ones the rest of this suite
   * runs in.
   */
  test('offers a confirm-gated restart for the local computer', async ({ mainWindow }) => {
    const group = await openComputersTab(mainWindow)

    // The local hub either HAS its computer (→ restart) or is missing it (→ start),
    // never neither. Which one shows depends on how far auto-enroll has got, so
    // accept both rather than racing enrollment.
    const restart = group.getByTestId('computer-local-restart')
    const start = group.getByTestId('computer-local-start')
    await expect
      .poll(async () => (await restart.count()) + (await start.count()), { timeout: 30_000 })
      .toBeGreaterThan(0)

    if ((await restart.count()) > 0) {
      // Enrolled: restart must be CONFIRM-GATED. Open the confirm and cancel —
      // actually restarting would kill the terminals the rest of the suite uses.
      await restart.first().click()
      // The confirm renders in its own portal, so it is not inside the settings
      // dialog's subtree — query from the window.
      await expect(mainWindow.getByTestId('computer-local-restart-confirm')).toBeVisible({
        timeout: 5_000
      })
      await mainWindow.keyboard.press('Escape')
      await expect(mainWindow.getByTestId('computer-local-restart-confirm')).toHaveCount(0, {
        timeout: 5_000
      })
    } else {
      // Auto-enroll has not landed yet, so the row is the "not running" one. Its
      // Start control must be live — that state is exactly when the user needs it.
      // Deliberately NOT clicked: spawning a computer mid-suite is not this spec's
      // business.
      await expect(start.first()).toBeEnabled()
    }

    await mainWindow.keyboard.press('Escape')
  })
})
