import { test, expect, clickSettings, resetApp } from '../fixtures/electron'

/**
 * Wave 3 — Runner settings tab (hub/runner split UI).
 *
 * Smoke-level guard that the new "Runner" tab renders inside the settings dialog
 * with runner mode OFF (the byte-identical default): the mode toggle shows
 * unchecked, and runner enrollment is disabled + explained until runner is booted
 * on. The "actually flips runner on and relaunches" path is a boot-config write +
 * a Playwright-noop relaunch (mirrors 100-server-settings-toggle.spec.ts) and is
 * covered by the RunnersSettingsTab unit test; this spec only proves the tab is
 * wired into the dialog and safe with runner off.
 */
test.describe('Runner settings tab', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  const openRunnersTab = async (mainWindow: import('@playwright/test').Page) => {
    const dialog = mainWindow.getByRole('dialog').last()
    if (!(await dialog.isVisible().catch(() => false))) {
      await clickSettings(mainWindow)
      await expect(dialog).toBeVisible({ timeout: 5_000 })
    }
    await dialog.locator('aside button').filter({ hasText: 'Connections' }).first().click()
    await expect(dialog.getByTestId('runners-enabled-toggle')).toBeVisible({ timeout: 5_000 })
    return dialog
  }

  test('renders the Runner tab with runner off by default', async ({ mainWindow }) => {
    const dialog = await openRunnersTab(mainWindow)

    // Runner off by default → toggle unchecked.
    await expect(dialog.getByTestId('runners-enabled-toggle')).toHaveAttribute('aria-checked', 'false')

    // Enrollment is gated on the booted runner state → disabled + explained.
    await expect(dialog.getByTestId('runner-add')).toBeDisabled()
    await expect(dialog.getByTestId('runner-enroll-disabled')).toBeVisible()

    await mainWindow.keyboard.press('Escape')
  })
})
