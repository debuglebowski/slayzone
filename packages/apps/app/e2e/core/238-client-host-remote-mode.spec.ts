import fs from 'node:fs'
import path from 'node:path'
import { test as base, expect } from '@playwright/test'
import {
  bootConfigPath,
  clientRoot,
  launchIsolatedElectron,
  newRuntimeDir,
  settingsView
} from '../fixtures/electron'
import { spawnSecondHub, waitForHubHealth, type SecondHub } from '../fixtures/second-hub'

/**
 * Remote mode — the app runs no hub of its own (task 557ebb72).
 *
 * Native menu items, the theme mode and the labs flags are this device's: Electron
 * main hands them to the renderer directly (the client host), never through a hub.
 * Before, they rode main → local-hub bridge → renderer, and remote mode has no local
 * hub, so the "Settings…" menu item did nothing and the theme never stuck.
 *
 * Raw Playwright base: the shared worker fixture assumes the app's own local hub.
 */
base.describe('Client host in remote mode', () => {
  let hub: SecondHub | null = null

  base.afterAll(async () => {
    await hub?.stop()
  })

  base('menu items and the theme work with no local hub', async () => {
    base.setTimeout(180_000)
    hub = await spawnSecondHub(newRuntimeDir('client-host-remote'), { login: false })
    await waitForHubHealth(hub.port)
    const url = hub.url

    const launched = await launchIsolatedElectron({
      name: 'client-host-remote',
      seedUserData: (userDataDir) => {
        const target = bootConfigPath(userDataDir)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(
          target,
          JSON.stringify({ server_mode: 'remote', remote_server_url: url }, null, 2)
        )
      },
      extraEnv: () => ({ SLAYZONE_E2E_NO_COMPUTER: '1' })
    })

    try {
      const { page, app, userDataDir } = launched
      await page.waitForSelector('[data-testid="home-tab"]', { timeout: 60_000 })

      // The native "Settings…" menu item opens Settings.
      await app.evaluate(({ Menu }) => {
        const appMenu = Menu.getApplicationMenu()?.items.find((i) => i.label === 'SlayZone')
        const item = appMenu?.submenu?.items.find((i) => i.label === 'Settings...')
        if (!item) throw new Error('Settings... menu item missing')
        item.click(undefined as never, undefined as never, undefined as never)
      })
      await expect(settingsView(page)).toBeVisible({ timeout: 10_000 })
      await page.keyboard.press('Escape')

      // The theme mode sticks: client.config.json + nativeTheme, with no hub involved.
      const effective = await page.evaluate(() =>
        (
          window as unknown as {
            api: { clientHost: { invoke: (m: string, a: unknown[]) => Promise<unknown> } }
          }
        ).api.clientHost.invoke('theme.set', ['light'])
      )
      expect(effective).toBe('light')
      const config = JSON.parse(
        fs.readFileSync(path.join(clientRoot(userDataDir), 'client.config.json'), 'utf8')
      ) as { theme?: string }
      expect(config.theme).toBe('light')
      expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('light')
    } finally {
      await launched.close()
    }
  })
})
