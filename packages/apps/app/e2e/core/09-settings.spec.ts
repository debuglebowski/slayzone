import { test, expect, seed, clickSettings, resetApp, settingsView } from '../fixtures/electron'

test.describe('Settings', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  const settingsDialog = (mainWindow: import('@playwright/test').Page) => settingsView(mainWindow)

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

  const openTerminalSettings = async (mainWindow: import('@playwright/test').Page) => {
    const dialog = settingsDialog(mainWindow)
    if (await dialog.isVisible().catch(() => false)) {
      await mainWindow.keyboard.press('Escape')
      await expect(dialog).not.toBeVisible({ timeout: 5_000 })
    }
    await openSettingsDialog(mainWindow)
    // The default agent is a hub setting: the hub's Agents & providers page.
    await dialog.getByTestId('settings-nav-hub').first().click()
    await dialog.getByTestId('hub-tab-agents').click()
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

  test('Panels section lists General and every panel page', async ({ mainWindow }) => {
    const view = await openSettingsDialog(mainWindow)
    await expect(view.getByTestId('settings-nav-panels')).toHaveText('General')
    await expect(view.getByTestId('settings-nav-panels-terminal')).toBeVisible()
    await view.getByTestId('settings-nav-panels').click()
    await expect(view.getByTestId('settings-nav-panels')).toHaveAttribute('aria-current', 'page')
    // About holds diagnostics; CLI has its own page.
    await view.getByTestId('settings-nav-about').click()
    await expect(view.getByText('Diagnostics enabled')).toBeVisible()
    await view.getByTestId('settings-nav-cli').click()
    await expect(view.getByRole('button', { name: /Install|Reinstall/ })).toBeVisible()
  })

  test('default agent setting saves from UI', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    await mainWindow.keyboard.press('Escape')
    await expect(settingsDialog(mainWindow)).not.toBeVisible({ timeout: 3_000 })

    await openTerminalSettings(mainWindow)

    const modeTrigger = settingsDialog(mainWindow).getByTestId('default-agent-select')
    await modeTrigger.click()
    await mainWindow.getByRole('option', { name: 'Codex', exact: true }).click()
    await expect(modeTrigger).toHaveText(/Codex/)
    await expect.poll(async () => s.getSetting('default_agent_id')).toBe('codex')

    // Restore default to claude-code so subsequent tests get the real default
    await s.setSetting('default_agent_id', 'claude-code')
  })

  test('close settings dialog', async ({ mainWindow }) => {
    await mainWindow.keyboard.press('Escape')
    await expect(settingsDialog(mainWindow)).not.toBeVisible({ timeout: 3_000 })
  })
})
