import { test, expect, clickSettings, resetApp } from '../fixtures/electron'

/**
 * Wave 3 — Fleet settings tab (hub/runner split UI).
 *
 * Smoke-level guard that the new "Fleet" tab renders inside the settings dialog
 * with fleet mode OFF (the byte-identical default): the mode toggle shows
 * unchecked, and runner enrollment is disabled + explained until fleet is booted
 * on. The "actually flips fleet on and relaunches" path is a boot-config write +
 * a Playwright-noop relaunch (mirrors 100-server-settings-toggle.spec.ts) and is
 * covered by the FleetSettingsTab unit test; this spec only proves the tab is
 * wired into the dialog and safe with fleet off.
 */
test.describe('Fleet settings tab', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  const openFleetTab = async (mainWindow: import('@playwright/test').Page) => {
    const dialog = mainWindow.getByRole('dialog').last()
    if (!(await dialog.isVisible().catch(() => false))) {
      await clickSettings(mainWindow)
      await expect(dialog).toBeVisible({ timeout: 5_000 })
    }
    await dialog.locator('aside button').filter({ hasText: 'Fleet' }).first().click()
    await expect(dialog.getByTestId('fleet-mode-toggle')).toBeVisible({ timeout: 5_000 })
    return dialog
  }

  test('renders the Fleet tab with fleet off by default', async ({ mainWindow }) => {
    const dialog = await openFleetTab(mainWindow)

    // Fleet off by default → toggle unchecked.
    await expect(dialog.getByTestId('fleet-mode-toggle')).toHaveAttribute('aria-checked', 'false')

    // Enrollment is gated on the booted fleet state → disabled + explained.
    await expect(dialog.getByTestId('fleet-add-runner')).toBeDisabled()
    await expect(dialog.getByTestId('fleet-enroll-disabled')).toBeVisible()

    await mainWindow.keyboard.press('Escape')
  })
})
