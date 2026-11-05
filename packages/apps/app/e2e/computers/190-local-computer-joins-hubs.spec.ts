import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test as base, expect } from '@playwright/test'
import {
  bootConfigPath,
  clickSettings,
  launchIsolatedElectron,
  waitForUsableComputer
} from '../fixtures/electron'
import {
  APP_DIR,
  authorizeHubInApp,
  spawnSecondHub,
  waitForHubHealth,
  withHubClient,
  type SecondHub
} from '../fixtures/second-hub'

/**
 * The app's own computer joins every hub the client lists — and there it can be
 * disabled, never deleted from the client.
 *
 * A second, standalone hub with login is listed in the app's boot config. Once the
 * app holds a session for it (a sign-in), the app mints a join token there for itself
 * and its running local computer enrolls — under this machine's name, never
 * "local-computer", which the hub would take for its own. Proves, end to end:
 *   1. JOIN — the hub lists a usable computer named after this machine, marked as a
 *      desktop's joined computer, and Settings marks that row "this computer" with no
 *      delete action;
 *   2. DISABLE — disabling it from Settings keeps it enrolled and connected, and the
 *      hub records it as disabled;
 *   3. RECOVERY — deleted on the hub by someone else, the computer is enrolled there
 *      again (a fresh token minted when its credential is refused), without a restart.
 */

type Row = {
  id: string
  name: string
  usable: boolean
  connected: boolean
  capabilities: string[]
  disabledAt: number | null
}

const listComputers = (hub: SecondHub): Promise<Row[]> =>
  withHubClient(hub, (c) => c.computers.list.query()) as Promise<Row[]>

const MACHINE = os.hostname().replace(/\.local$/i, '') || 'computer'

base.describe('local computer on every hub', () => {
  base('joins a listed hub, can be disabled there, and re-joins when deleted', async () => {
    base.setTimeout(240_000)
    const store = fs.mkdtempSync(path.join(APP_DIR, 'e2e-join-hub-'))
    let hub: SecondHub | null = null
    let launched: Awaited<ReturnType<typeof launchIsolatedElectron>> | null = null
    try {
      hub = await spawnSecondHub(store)
      await waitForHubHealth(hub.port)
      const hubUrl = hub.url
      launched = await launchIsolatedElectron({
        name: 'local-computer-joins-hubs',
        seedUserData: (userDataDir) => {
          fs.mkdirSync(path.dirname(bootConfigPath(userDataDir)), { recursive: true })
          fs.writeFileSync(
            bootConfigPath(userDataDir),
            JSON.stringify({
              server_mode: 'local',
              multi_hub: true,
              hubs: [{ id: 'remote-b', kind: 'remote', label: 'Hub B', url: hubUrl }],
              default_hub_id: 'local'
            })
          )
        },
        extraEnv: (userDataDir) => ({ SLAYZONE_ROOT: userDataDir })
      })
      const page = launched.page
      await page.waitForSelector('#root', { timeout: 20_000 })
      expect(await waitForUsableComputer(page), 'local computer up').toBe(true)

      // No session yet → nothing joined there.
      expect((await listComputers(hub)).some((r) => r.name === MACHINE)).toBe(false)

      // 1. JOIN — signing in is what lets it join.
      await authorizeHubInApp(page, 'remote-b', hub.token)
      let joined: Row | undefined
      await expect
        .poll(
          async () => {
            joined = (await listComputers(hub!)).find((r) => r.name === MACHINE && r.usable)
            return joined !== undefined
          },
          { timeout: 60_000, message: 'local computer usable on hub B' }
        )
        .toBe(true)
      expect(joined!.capabilities).toContain('desktop')
      expect((await listComputers(hub)).some((r) => r.name === 'local-computer')).toBe(false)

      await clickSettings(page)
      const dialog = page.locator('[role="dialog"][aria-label="Settings"]').first()
      await expect(dialog).toBeVisible({ timeout: 10_000 })
      await dialog.locator('aside button').filter({ hasText: 'Connections' }).first().click()
      const group = page.locator('[data-testid="hub-group-remote-b"]')
      const ownRow = group.locator('[data-testid="computer-row"]').filter({
        has: page.locator('[data-testid="computer-own"]')
      })
      await expect(ownRow).toHaveCount(1, { timeout: 20_000 })
      await expect(ownRow.locator('[data-testid="computer-delete"]')).toHaveCount(0)

      // 2. DISABLE — from Settings; it stays enrolled and connected.
      await ownRow.locator('[data-testid="computer-disable"]').click()
      await expect(ownRow.locator('[data-testid="computer-enable"]')).toBeVisible({
        timeout: 15_000
      })
      const disabled = (await listComputers(hub)).find((r) => r.id === joined!.id)
      expect(disabled?.disabledAt, 'disabled on the hub').not.toBeNull()
      expect(disabled?.connected, 'still connected').toBe(true)
      await ownRow.locator('[data-testid="computer-enable"]').click()
      await expect(ownRow.locator('[data-testid="computer-disable"]')).toBeVisible({
        timeout: 15_000
      })

      // 3. RECOVERY — deleted on the hub, it enrolls there again by itself.
      await withHubClient(hub, (c) => c.computers.delete.mutate({ computerId: joined!.id }))
      await expect
        .poll(
          async () =>
            (await listComputers(hub!)).some(
              (r) => r.name === MACHINE && r.usable && r.id !== joined!.id
            ),
          { timeout: 90_000, message: 'local computer re-joined hub B' }
        )
        .toBe(true)
      // And the app's own hub kept its computer throughout.
      expect(await waitForUsableComputer(page, 10_000), 'local computer still up').toBe(true)
    } finally {
      if (launched) await launched.close()
      if (hub) await hub.stop()
      fs.rmSync(store, { recursive: true, force: true })
    }
  })
})
