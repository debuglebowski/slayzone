import fs from 'fs'
import path from 'path'
import { test, expect, clickSettings, resetApp } from '../fixtures/electron'

declare global {
  interface Window {
    __testInvoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  }
}

/**
 * Slice 7 — Local/Remote server-mode toggle in user settings.
 *
 * `Save & relaunch` writes the pre-boot config FILE (not the DB) and calls
 * app:relaunch — which is a no-op under PLAYWRIGHT (the harness owns the
 * process). So the spec asserts on the boot-config.json contents; the
 * "actually boots into remote mode" path is covered by
 * 103-remote-config-screen.spec.ts via an isolated pre-seeded launch.
 */
test.describe('Server settings toggle', () => {
  let bootConfigPath: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const env = (await mainWindow.evaluate(() =>
      window.__testInvoke('e2e:get-env', ['SLAYZONE_DB_DIR'])
    )) as { SLAYZONE_DB_DIR?: string }
    expect(env.SLAYZONE_DB_DIR).toBeTruthy()
    bootConfigPath = path.join(env.SLAYZONE_DB_DIR!, 'boot-config.json')
  })

  const readBootConfig = (): { server_mode?: string; remote_server_url?: string } | null => {
    try {
      return JSON.parse(fs.readFileSync(bootConfigPath, 'utf8'))
    } catch {
      return null
    }
  }

  const openServerTab = async (mainWindow: import('@playwright/test').Page) => {
    const dialog = mainWindow.getByRole('dialog').last()
    if (!(await dialog.isVisible().catch(() => false))) {
      await clickSettings(mainWindow)
      await expect(dialog).toBeVisible({ timeout: 5_000 })
    }
    await dialog.locator('aside button').filter({ hasText: 'Server' }).first().click()
    await expect(dialog.getByTestId('server-mode-local')).toBeVisible({ timeout: 5_000 })
    return dialog
  }

  test('defaults to Local with the URL input disabled', async ({ mainWindow }) => {
    const dialog = await openServerTab(mainWindow)
    await expect(dialog.getByTestId('server-mode-local')).toBeChecked()
    await expect(dialog.getByTestId('server-mode-remote')).not.toBeChecked()
    await expect(dialog.getByTestId('server-remote-url')).toBeDisabled()
    await expect(dialog.getByTestId('server-save-relaunch')).toBeDisabled()
  })

  test('Save & relaunch writes the normalized remote config to boot-config.json', async ({
    mainWindow
  }) => {
    const dialog = await openServerTab(mainWindow)
    await dialog.getByTestId('server-mode-remote').check()
    await dialog.getByTestId('server-remote-url').fill('http://127.0.0.1:45991')
    await dialog.getByTestId('server-save-relaunch').click()

    await expect
      .poll(() => readBootConfig(), { timeout: 5_000 })
      .toEqual({ server_mode: 'remote', remote_server_url: 'ws://127.0.0.1:45991/trpc' })
    // Relaunch was a Playwright no-op — the tab reflects the saved state.
    await expect(dialog.getByText('Unsaved changes')).not.toBeVisible()
  })

  test('an invalid URL is rejected and the file stays untouched', async ({ mainWindow }) => {
    const dialog = await openServerTab(mainWindow)
    await dialog.getByTestId('server-mode-remote').check()
    await dialog.getByTestId('server-remote-url').fill('not a url')
    await dialog.getByTestId('server-save-relaunch').click()

    // Save surfaces the rejection as a toast; the config keeps the last value.
    await expect(mainWindow.getByText(/Failed to save/)).toBeVisible({ timeout: 5_000 })
    expect(readBootConfig()).toEqual({
      server_mode: 'remote',
      remote_server_url: 'ws://127.0.0.1:45991/trpc'
    })
  })

  test('switching back to Local persists (URL kept for next time)', async ({ mainWindow }) => {
    const dialog = await openServerTab(mainWindow)
    await dialog.getByTestId('server-mode-local').check()
    await dialog.getByTestId('server-save-relaunch').click()

    await expect
      .poll(() => readBootConfig()?.server_mode, { timeout: 5_000 })
      .toBe('local')

    await mainWindow.keyboard.press('Escape')
  })
})
