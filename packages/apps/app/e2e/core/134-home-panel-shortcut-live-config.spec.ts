import {
  test,
  expect,
  seed,
  goHome,
  clickProject,
  clickSettings,
  resetApp
} from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'

// Home-tab panel shortcuts read the CURRENT settings when a key fires. Turning
// the Tests panel on in Labs (and closing Settings) must make its shortcut work at
// once — the listener used to keep the flag it was registered with, so Mod+U did
// nothing until the project or the panel visibility changed.

const homePanelBtn = (page: import('@playwright/test').Page, label: string) =>
  page
    .locator('.bg-surface-2.rounded-lg')
    .filter({ has: page.locator(`button:has-text("Kanban")`) })
    .locator(`button:has-text("${label}")`)

const setTestsPanelLab = (page: import('@playwright/test').Page, on: boolean) =>
  page.evaluate(
    (v) =>
      window.getTrpcVanillaClient().app.meta.setLabFlag.mutate({ key: 'labs_tests_panel', on: v }),
    on
  )

test.describe('Home panel shortcut follows the Tests panel lab flag', () => {
  test.beforeAll(async ({ mainWindow }) => {
    // The flag lives in the client store (not the DB): set it before the reset's reload.
    await setTestsPanelLab(mainWindow, false)
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Hotkey Labs',
      color: '#22c55e',
      path: TEST_PROJECT_PATH
    })
    await s.createTask({ projectId: p.id, title: 'HK labs task', status: 'todo' })
    await s.refreshData()

    await goHome(mainWindow)
    await clickProject(mainWindow, p.name.slice(0, 2).toUpperCase())
    await expect(mainWindow.getByText('HK labs task').first()).toBeVisible({ timeout: 5_000 })
    await expect(homePanelBtn(mainWindow, 'Tests')).toHaveCount(0)
  })

  test.afterAll(async ({ mainWindow }) => {
    await setTestsPanelLab(mainWindow, false)
  })

  test('enabling the Tests panel makes Mod+U toggle it', async ({ mainWindow }) => {
    // The user path: Settings → Labs → Tests panel on → close Settings.
    await clickSettings(mainWindow)
    const dialog = mainWindow.getByRole('dialog').last()
    await expect(dialog).toBeVisible({ timeout: 5_000 })
    await dialog.locator('aside button').filter({ hasText: 'Labs' }).first().click()
    const toggle = dialog.locator('#labs_tests_panel')
    await expect(toggle).toBeVisible({ timeout: 5_000 })
    await toggle.click()
    await expect(toggle).toHaveAttribute('data-state', 'checked')
    await mainWindow.keyboard.press('Escape')
    await expect(dialog).toBeHidden({ timeout: 5_000 })

    const btn = homePanelBtn(mainWindow, 'Tests')
    await expect(btn).toBeVisible({ timeout: 5_000 })
    await expect(btn).not.toHaveClass(/(?:^|\s)bg-surface-3(?:\s|$)/)

    await mainWindow.keyboard.press('Meta+u')
    await expect(btn).toHaveClass(/(?:^|\s)bg-surface-3(?:\s|$)/, { timeout: 3_000 })
  })
})
