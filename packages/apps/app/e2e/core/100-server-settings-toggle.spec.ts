import fs from 'fs'
import path from 'path'
import { test, expect, clickSettings, resetApp } from '../fixtures/electron'

declare global {
  interface Window {
    __testInvoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  }
}

/**
 * Connections → Hubs: the "Run a local hub" toggle (replaces the old Server-tab
 * Local/Remote radio). It writes `server_mode` in the pre-boot config FILE (not
 * the DB): local on → `server_mode: 'local'` (spawn embedded backend); local off
 * → `server_mode: 'remote'` (pure client). `Save & relaunch`'s relaunch is a
 * no-op under PLAYWRIGHT, so the spec asserts on boot-config.json.
 *
 * Turning local OFF requires ≥1 remote hub to fall back to (the app must always
 * have a hub), so the spec adds a remote hub first.
 */
test.describe('Run-local-hub toggle', () => {
  let bootConfigPath: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const env = (await mainWindow.evaluate(() =>
      window.__testInvoke('e2e:get-env', ['SLAYZONE_DB_DIR'])
    )) as { SLAYZONE_DB_DIR?: string }
    expect(env.SLAYZONE_DB_DIR).toBeTruthy()
    bootConfigPath = path.join(env.SLAYZONE_DB_DIR!, 'boot-config.json')
  })

  const readBootConfig = (): {
    server_mode?: string
    multi_hub?: boolean
    hubs?: Array<{ id: string; url?: string }>
  } | null => {
    try {
      return JSON.parse(fs.readFileSync(bootConfigPath, 'utf8'))
    } catch {
      return null
    }
  }

  const openHubsTab = async (mainWindow: import('@playwright/test').Page) => {
    const dialog = mainWindow.getByRole('dialog').last()
    if (!(await dialog.isVisible().catch(() => false))) {
      await clickSettings(mainWindow)
      await expect(dialog).toBeVisible({ timeout: 5_000 })
    }
    await dialog.locator('aside button').filter({ hasText: 'Connections' }).first().click()
    await expect(dialog.getByTestId('hub-local-toggle')).toBeVisible({ timeout: 5_000 })
    return dialog
  }

  test('local hub runs by default; toggle is disabled with no remotes', async ({ mainWindow }) => {
    const dialog = await openHubsTab(mainWindow)
    // Local hub row present + running; can't turn it off (nothing to fall back to).
    await expect(dialog.getByTestId('hub-row-local')).toBeVisible()
    await expect(dialog.getByTestId('hub-local-toggle')).toBeChecked()
    await expect(dialog.getByTestId('hub-local-toggle')).toBeDisabled()
    await expect(dialog.getByTestId('hubs-save-relaunch')).toBeDisabled()
    await mainWindow.keyboard.press('Escape')
  })

  test('add a remote + turn local off → boot-config becomes a pure client', async ({
    mainWindow
  }) => {
    // Use the app's OWN live sidecar as the "remote" hub to add — its /health is
    // reachable, so the probe passes deterministically and Add arms. (We're
    // testing the toggle→boot-config write, not real federation.)
    const server = (await mainWindow.evaluate(() =>
      window.__testInvoke('app:get-server-url')
    )) as { mode: string; url: string }
    const host = new URL(server.url.replace(/^ws/, 'http')).host

    const dialog = await openHubsTab(mainWindow)
    await dialog.getByTestId('hub-add-url').fill(`http://${host}`)
    await dialog.getByTestId('hub-probe').click()
    const addBtn = dialog.getByTestId('hub-add')
    await expect(addBtn).toBeEnabled({ timeout: 10_000 })
    await addBtn.click()

    // Now local can be turned off (there's a remote to fall back to).
    const toggle = dialog.getByTestId('hub-local-toggle')
    await expect(toggle).toBeEnabled()
    await toggle.click() // → off
    await dialog.getByTestId('hubs-save-relaunch').click()

    await expect.poll(() => readBootConfig()?.server_mode, { timeout: 5_000 }).toBe('remote')
    const cfg = readBootConfig()
    expect(cfg?.multi_hub).toBe(true)
    expect((cfg?.hubs ?? []).length).toBeGreaterThan(0)

    // Restore the shared worker app to the default (local hub on, no remotes) so
    // sibling specs in this worker (104 restart) see a running local hub. Turn
    // local back on, remove the remote, save.
    await toggle.click() // → on
    await dialog.getByTestId('hub-remove').first().click()
    await dialog.getByTestId('hubs-save-relaunch').click()
    await expect.poll(() => readBootConfig()?.server_mode, { timeout: 5_000 }).toBe('local')
    await mainWindow.keyboard.press('Escape').catch(() => {})
  })
})
