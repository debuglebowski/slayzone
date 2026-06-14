import { test, expect, seed, clickSettings, resetApp } from '../fixtures/electron'

test.describe('Settings', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  const settingsDialog = (mainWindow: import('@playwright/test').Page) =>
    mainWindow.getByRole('dialog').last()

  const openSettingsDialog = async (mainWindow: import('@playwright/test').Page) => {
    const dialog = settingsDialog(mainWindow)
    if (!(await dialog.isVisible().catch(() => false))) {
      await clickSettings(mainWindow)
      await expect(dialog).toBeVisible({ timeout: 5_000 })
    }
    // Default tab is Appearance — wait for it to render rather than nav-switching.
    await expect(dialog.getByText('Color theme')).toBeVisible({ timeout: 5_000 })
    return dialog
  }

  const findCard = (dialog: import('@playwright/test').Locator, name: string) =>
    dialog.locator('.space-y-2 > *').filter({ hasText: name }).first()

  const openTerminalSettings = async (mainWindow: import('@playwright/test').Page) => {
    const dialog = settingsDialog(mainWindow)
    if (await dialog.isVisible().catch(() => false)) {
      await mainWindow.keyboard.press('Escape')
      await expect(dialog).not.toBeVisible({ timeout: 5_000 })
    }
    await openSettingsDialog(mainWindow)
    await dialog.locator('aside button').filter({ hasText: 'Panels' }).first().click()
    // Terminal panel was relabeled "Agent" in the panels list.
    await expect(findCard(settingsDialog(mainWindow), 'Agent')).toBeVisible({ timeout: 5_000 })
    const terminalCard = findCard(dialog, 'Agent')
    await terminalCard.click()
    await expect(dialog.getByText('Default agent provider')).toBeVisible({ timeout: 5_000 })
  }

  test('open settings dialog', async ({ mainWindow }) => {
    await openSettingsDialog(mainWindow)
  })

  test('Cmd+, opens settings dialog', async ({ mainWindow }) => {
    await mainWindow.keyboard.press('Meta+,')
    await expect(settingsDialog(mainWindow)).toBeVisible({ timeout: 5_000 })
    await expect(settingsDialog(mainWindow).getByText('Color theme')).toBeVisible({
      timeout: 5_000
    })
  })

  test('switch theme to dark', async ({ mainWindow }) => {
    const dialog = await openSettingsDialog(mainWindow)
    await dialog.locator('aside button').filter({ hasText: 'Appearance' }).first().click()
    const modeTrigger = dialog.locator('[data-slot="select-trigger"]').first()
    await modeTrigger.click()
    await mainWindow.getByRole('option', { name: 'Dark', exact: true }).click()
    await expect(mainWindow.locator('html')).toHaveClass(/dark/)
  })

  test('switch theme to light', async ({ mainWindow }) => {
    const dialog = await openSettingsDialog(mainWindow)
    await dialog.locator('aside button').filter({ hasText: 'Appearance' }).first().click()
    const modeTrigger = dialog.locator('[data-slot="select-trigger"]').first()
    await modeTrigger.click()
    await mainWindow.getByRole('option', { name: /Light/ }).click()
    await expect(mainWindow.locator('html')).not.toHaveClass(/dark/)
  })

  test('default terminal mode setting saves from UI', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    await mainWindow.keyboard.press('Escape')
    await expect(settingsDialog(mainWindow)).not.toBeVisible({ timeout: 3_000 })

    await openTerminalSettings(mainWindow)

    const modeTrigger = settingsDialog(mainWindow)
      .getByText('Default agent provider')
      .locator('xpath=..')
      .locator('[data-slot="select-trigger"]')
      .first()
    await modeTrigger.click()
    await mainWindow.getByRole('option', { name: 'Codex', exact: true }).click()
    await expect(modeTrigger).toHaveText(/Codex/)
    await expect.poll(async () => s.getSetting('default_terminal_mode')).toBe('codex')

    // Restore default to claude-code so subsequent tests get the real default
    await s.setSetting('default_terminal_mode', 'claude-code')
  })

  test('close settings dialog', async ({ mainWindow }) => {
    await mainWindow.keyboard.press('Escape')
    await expect(settingsDialog(mainWindow)).not.toBeVisible({ timeout: 3_000 })
  })
})
