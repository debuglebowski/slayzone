import { test, expect, seed, resetApp } from '../fixtures/electron'

test.describe('Onboarding', () => {
  test.beforeEach(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('onboarding is skipped when pre-seeded', async ({ mainWindow }) => {
    const completed = await mainWindow.evaluate(() =>
      window.getTrpcVanillaClient().settings.get.query({ key: 'onboarding_completed' })
    )
    expect(completed).toBe('true')
    await expect(mainWindow.getByText('Welcome to SlayZone', { exact: true })).not.toBeVisible()
  })

  test('full onboarding flow', async ({ mainWindow }) => {
    const s = seed(mainWindow)

    try {
      // Clear the flag to trigger the dialog on reload
      await s.setSetting('onboarding_completed', '')
      await mainWindow.evaluate(() => {
        ;(window as any).__slayzone_dialogStore.getState().openOnboarding()
      })

      // Step 0: Welcome
      await expect(
        mainWindow.getByText('Welcome to SlayZone', { exact: true }).first()
      ).toBeVisible({ timeout: 10_000 })
      const dialog = mainWindow.locator('[role="dialog"]').last()
      await dialog.getByRole('button', { name: 'Continue' }).click()

      // Step 1: Disclaimer
      await expect(dialog.getByText('Your AI, your responsibility')).toBeVisible()
      await dialog.getByRole('button', { name: 'I understand' }).click()

      // Step 2: Provider selection
      await expect(dialog.getByText('Choose your default AI')).toBeVisible()
      await dialog.getByRole('button', { name: 'Continue' }).click()

      // Step 3: Analytics
      await expect(dialog.getByText('Analytics', { exact: true })).toBeVisible()
      await dialog.getByRole('button', { name: 'No' }).click()

      // Step 4: CLI install
      await expect(dialog.getByText(/Install the slay CLI|CLI installed\./i)).toBeVisible()
      if (
        await dialog
          .getByRole('button', { name: 'Skip' })
          .isVisible()
          .catch(() => false)
      ) {
        await dialog.getByRole('button', { name: 'Skip' }).click()
      } else {
        await dialog.getByRole('button', { name: 'Continue' }).click()
      }

      // Step 5: Success (auto-closes after ~1.8s)
      await expect(dialog.getByText("You're all set!")).toBeVisible()
      await expect(dialog).not.toBeVisible({ timeout: 5_000 })

      // Verify persistence
      const completed = await mainWindow.evaluate(() =>
        window.getTrpcVanillaClient().settings.get.query({ key: 'onboarding_completed' })
      )
      expect(completed).toBe('true')
    } finally {
      // Restore flag so subsequent tests never see the onboarding dialog
      await s.setSetting('onboarding_completed', 'true')
      await mainWindow.reload({ waitUntil: 'domcontentloaded' })
      await mainWindow.waitForSelector('#root', { timeout: 10_000 })
    }
  })
})
