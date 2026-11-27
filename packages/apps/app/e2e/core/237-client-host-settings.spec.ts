import fs from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { toElectronAccelerator } from '@slayzone/shortcuts'
import {
  test,
  expect,
  seed,
  resetApp,
  goHome,
  openTaskById,
  settingsView,
  cliRoot,
  clientRoot,
  TEST_PROJECT_PATH
} from '../fixtures/electron'

/**
 * Client-local settings (task 557ebb72): the keyboard-shortcut overrides, theme mode
 * and labs flags live in THIS device's `client.config.json`, which Electron main
 * reads to build the native menu and its `before-input-event` key matcher.
 *
 * Before: the renderer wrote overrides to the hub; main rebuilt the menu from the
 * file nothing updated, so the menu kept the OLD accelerator and main kept
 * swallowing the OLD key.
 */

const clientConfig = async (app: ElectronApplication): Promise<Record<string, unknown>> => {
  const file = path.join(clientRoot(await cliRoot(app)), 'client.config.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

const menuAccelerator = (app: ElectronApplication, labels: string[]) =>
  app.evaluate(({ Menu }, p: string[]) => {
    let items = Menu.getApplicationMenu()?.items ?? []
    let current: Electron.MenuItem | undefined
    for (const label of p) {
      current = items.find((item) => item.label === label)
      if (!current) return `missing:${label}`
      items = current.submenu?.items ?? []
    }
    return current?.accelerator ?? null
  }, labels)

const openShortcutsDialog = async (page: Page) => {
  await page.locator('button[aria-label="Keyboard Shortcuts"]').click()
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 3_000 })
}

const closeDialog = async (page: Page) => {
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 3_000 })
}

const rebind = async (page: Page, label: string, keys: string) => {
  await openShortcutsDialog(page)
  const dialog = page.getByRole('dialog')
  const labelSpan = dialog.locator(`span.text-sm:text-is("${label}")`).first()
  if (!(await labelSpan.isVisible({ timeout: 300 }).catch(() => false))) {
    const groups = dialog.locator('button[data-state]')
    const count = await groups.count()
    for (let i = 0; i < count; i++) {
      await groups.nth(i).click()
      if (await labelSpan.isVisible({ timeout: 300 }).catch(() => false)) break
    }
  }
  await labelSpan.locator('..').locator('span.cursor-pointer').first().click()
  await expect(page.getByText('Press keys...')).toBeVisible({ timeout: 2_000 })
  await page.keyboard.press(keys)
  await closeDialog(page)
}

const resetShortcuts = async (page: Page) => {
  await openShortcutsDialog(page)
  await page.getByText('Reset to Defaults').click()
  await closeDialog(page)
}

test.describe('Client-local settings drive the native menu', () => {
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Client Host',
      color: '#22c55e',
      path: TEST_PROJECT_PATH
    })
    taskId = (await s.createTask({ projectId: p.id, title: 'Client host task', status: 'todo' })).id
    await s.refreshData()
    await goHome(mainWindow)
  })

  test.afterAll(async ({ mainWindow }) => {
    await goHome(mainWindow).catch(() => undefined)
    await resetShortcuts(mainWindow).catch(() => undefined)
  })

  test('a rebind reaches client.config.json and the native menu accelerator', async ({
    mainWindow,
    electronApp
  }) => {
    test.skip(process.platform !== 'darwin', 'the custom app menu is built on macOS only')
    await rebind(mainWindow, 'New Temporary Task', 'Meta+Alt+y')
    await expect
      .poll(async () => (await clientConfig(electronApp)).customShortcuts, { timeout: 5_000 })
      .toMatchObject({ 'new-temp-task': 'mod+alt+y' })
    await expect
      .poll(() => menuAccelerator(electronApp, ['File', 'New Temporary Task']), {
        timeout: 5_000
      })
      .toBe(toElectronAccelerator('mod+alt+y'))
  })

  test('main stops swallowing the OLD key and answers the new one', async ({
    mainWindow,
    electronApp
  }) => {
    await rebind(mainWindow, 'Global Settings', 'Meta+Alt+u')
    await openTaskById(mainWindow, taskId)

    // A real key in the main window: `sendInputEvent` runs main's `before-input-event`
    // matcher (Playwright's CDP keys reach the page without it).
    const press = (keyCode: string, modifiers: string[]) =>
      electronApp.evaluate(
        ({ BrowserWindow }, a: { keyCode: string; modifiers: string[] }) => {
          const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())!
          win.webContents.sendInputEvent({
            type: 'keyDown',
            keyCode: a.keyCode,
            modifiers: a.modifiers as Electron.KeyboardInputEvent['modifiers']
          })
          win.webContents.sendInputEvent({
            type: 'keyUp',
            keyCode: a.keyCode,
            modifiers: a.modifiers as Electron.KeyboardInputEvent['modifiers']
          })
        },
        { keyCode, modifiers }
      )

    // Old key: nothing may open Settings any more.
    await press(',', ['meta'])
    await mainWindow.waitForTimeout(800)
    await expect(settingsView(mainWindow)).not.toBeVisible()

    // New key: main's before-input-event matcher (from the file) opens it.
    await press('U', ['meta', 'alt'])
    await expect(settingsView(mainWindow)).toBeVisible({ timeout: 5_000 })
    await mainWindow.keyboard.press('Escape')
    await expect(settingsView(mainWindow)).not.toBeVisible({ timeout: 5_000 })
  })

  test('theme mode persists to client.config.json and drives nativeTheme', async ({
    mainWindow,
    electronApp
  }) => {
    const set = (pref: string) =>
      mainWindow.evaluate(
        (p) =>
          (
            window as unknown as {
              api: { clientHost: { invoke: (m: string, a: unknown[]) => Promise<unknown> } }
            }
          ).api.clientHost.invoke('theme.set', [p]),
        pref
      )
    try {
      expect(await set('light')).toBe('light')
      expect((await clientConfig(electronApp)).theme).toBe('light')
      expect(await electronApp.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('light')
    } finally {
      await set('dark')
    }
  })
})
