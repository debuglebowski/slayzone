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
    const dialog = mainWindow.getByRole('dialog').last()
    if (!(await dialog.isVisible().catch(() => false))) {
      await clickSettings(mainWindow)
      await expect(dialog).toBeVisible({ timeout: 5_000 })
    }
    await dialog.locator('aside button').filter({ hasText: 'Connections' }).first().click()
    await expect(dialog.getByTestId('runner-add')).toBeVisible({ timeout: 5_000 })
    return dialog
  }

  test('renders the Runners section with enrollment always available (no toggle)', async ({
    mainWindow
  }) => {
    const dialog = await openRunnersTab(mainWindow)

    // Enrollment is always on — the Add button is enabled from the start.
    await expect(dialog.getByTestId('runner-add')).toBeEnabled()

    // The old enable-mode toggle + its disabled-until-booted explainer are gone.
    await expect(dialog.getByTestId('runners-enabled-toggle')).toHaveCount(0)
    await expect(dialog.getByTestId('runner-enroll-disabled')).toHaveCount(0)

    await mainWindow.keyboard.press('Escape')
  })
})
