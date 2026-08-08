import fs from 'fs'
import { test, expect, clickSettings, resetApp, bootConfigPath } from '../fixtures/electron'

/**
 * Connections → Hubs: the "Run a local hub" toggle (replaces the old Server-tab
 * Local/Remote radio). It writes `server_mode` in the pre-boot config FILE (not
 * the DB): local on → `server_mode: 'local'` (spawn embedded backend); local off
 * → `server_mode: 'remote'` (pure client). `Save & relaunch`'s relaunch is a
 * no-op under PLAYWRIGHT, so the spec asserts on boot-config.json.
 *
 * Turning local OFF requires ≥1 remote hub to fall back to (the app must always
 * have a hub), so the spec adds a remote hub first.
 *
 * MENUS. Each hub card now ends in fixed slots — status, primary action, `⋯` —
 * and the occasional actions moved behind that `⋯`: "Run a local hub" on the
 * local card, Verify/Edit/Remove on a remote one. So every interaction below
 * opens the relevant menu first. Radix renders menu content in a PORTAL, outside
 * the settings dialog's subtree, so menu items are located from the WINDOW while
 * the triggers are located inside the dialog.
 */
test.describe('Run-local-hub toggle', () => {
  // Named distinctly from the imported `bootConfigPath` helper: a local
  // `let bootConfigPath` shadowed it, so the call below resolved to this
  // (still-undefined) string and threw "bootConfigPath is not a function" in
  // beforeAll — taking the whole describe down with it.
  let configPath: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const env = (await mainWindow.evaluate(() =>
      window.__testInvoke('e2e:get-env', ['SLAYZONE_USER_DATA_DIR'])
    )) as { SLAYZONE_USER_DATA_DIR?: string }
    expect(env.SLAYZONE_USER_DATA_DIR).toBeTruthy()
    configPath = bootConfigPath(env.SLAYZONE_USER_DATA_DIR!)
  })

  const readBootConfig = (): {
    server_mode?: string
    multi_hub?: boolean
    hubs?: Array<{ id: string; url?: string }>
  } | null => {
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'))
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
    await expect(dialog.getByTestId('hub-row-local')).toBeVisible({ timeout: 5_000 })
    // The add-hub form lives in a collapsed "＋ Add new hub" row now — expand it so
    // the url/probe/add fields are reachable (idempotent across tests).
    const opener = dialog.getByTestId('hub-add-open')
    if (await opener.isVisible().catch(() => false)) await opener.click()
    return dialog
  }

  /**
   * Open a card's `⋯` and return the menu item, located from the window because
   * the content is portalled. Re-opened per interaction: selecting an item closes
   * the menu, so a handle from a previous open is detached.
   */
  const openMenuItem = async (
    mainWindow: import('@playwright/test').Page,
    dialog: ReturnType<import('@playwright/test').Page['getByRole']>,
    trigger: string,
    item: string
  ) => {
    await dialog.getByTestId(trigger).first().click()
    const menuItem = mainWindow.getByTestId(item).first()
    await expect(menuItem).toBeVisible({ timeout: 5_000 })
    return menuItem
  }

  test('local hub runs by default; toggle is disabled with no remotes', async ({ mainWindow }) => {
    const dialog = await openHubsTab(mainWindow)
    // Local hub card present, and its status says so without opening anything.
    await expect(dialog.getByTestId('hub-row-local')).toBeVisible()
    await expect(dialog.getByTestId('hub-row-local').getByTestId('hub-status')).toHaveText(
      /Running/
    )

    // Can't turn it off — nothing to fall back to. `aria-checked`/`aria-disabled`
    // rather than toBeChecked/toBeDisabled: the control is a menuitemcheckbox now,
    // which those matchers do not cover.
    const toggle = await openMenuItem(mainWindow, dialog, 'hub-more-local', 'hub-local-toggle')
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect(toggle).toHaveAttribute('aria-disabled', 'true')
    await mainWindow.keyboard.press('Escape') // close the menu

    // Save button only renders when there are unsaved changes — none on open.
    await expect(dialog.getByTestId('hubs-save-relaunch')).toHaveCount(0)
    await mainWindow.keyboard.press('Escape')
  })

  test('add a remote + turn local off → boot-config becomes a pure client', async ({
    mainWindow
  }) => {
    // Use the app's OWN live sidecar as the "remote" hub to add — its /health is
    // reachable, so the probe passes deterministically and Add arms. (We're
    // testing the toggle→boot-config write, not real federation.)
    const server = (await mainWindow.evaluate(() => window.__testInvoke('app:get-server-url'))) as {
      mode: string
      url: string
    }
    const host = new URL(server.url.replace(/^ws/, 'http')).host

    const dialog = await openHubsTab(mainWindow)
    await dialog.getByTestId('hub-add-url').fill(`http://${host}`)
    await dialog.getByTestId('hub-probe').click()
    const addBtn = dialog.getByTestId('hub-add')
    await expect(addBtn).toBeEnabled({ timeout: 10_000 })
    await addBtn.click()

    // Now local can be turned off (there's a remote to fall back to).
    const toggleOff = await openMenuItem(mainWindow, dialog, 'hub-more-local', 'hub-local-toggle')
    // Enabled means the attribute is ABSENT, not "false": Radix renders
    // `aria-disabled: disabled || undefined`, so there is no such attribute to
    // read on an enabled item. Asserting the string "false" can never pass.
    await expect(toggleOff).not.toHaveAttribute('aria-disabled', /.*/)
    await toggleOff.click() // → off
    await dialog.getByTestId('hubs-save-relaunch').click()

    await expect.poll(() => readBootConfig()?.server_mode, { timeout: 5_000 }).toBe('remote')
    const cfg = readBootConfig()
    expect(cfg?.multi_hub).toBe(true)
    expect((cfg?.hubs ?? []).length).toBeGreaterThan(0)

    // Restore the shared worker app to the default (local hub on, no remotes) so
    // sibling specs in this worker (104 restart) see a running local hub. Turn
    // local back on, remove the remote, save.
    const toggleOn = await openMenuItem(mainWindow, dialog, 'hub-more-local', 'hub-local-toggle')
    await toggleOn.click() // → on
    const remove = await openMenuItem(mainWindow, dialog, 'hub-more-remote', 'hub-remove')
    await remove.click()
    await dialog.getByTestId('hubs-save-relaunch').click()
    await expect.poll(() => readBootConfig()?.server_mode, { timeout: 5_000 }).toBe('local')
    await mainWindow.keyboard.press('Escape').catch(() => {})
  })
})
