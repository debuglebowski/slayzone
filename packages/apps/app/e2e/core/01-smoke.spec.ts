import { test, expect, resetApp } from '../fixtures/electron'

test.describe('App launch', () => {
  test.beforeEach(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('shows main window with empty state', async ({ mainWindow }) => {
    // The empty-state copy lives in HomeDetail, which only renders inside the
    // ACTIVE home tab. resetApp reloads the renderer; if the home tab isn't the
    // active view afterwards the copy is mounted in a display:none container →
    // the element exists but reports `hidden` for the whole timeout. Activate the
    // home tab first (wait for its icon to render after the reload), then assert.
    const homeIcon = mainWindow.locator('.lucide-house, .lucide-home').first()
    await expect(homeIcon).toBeVisible({ timeout: 10_000 })
    await homeIcon.click({ timeout: 3_000 }).catch(() => {})
    // The exact empty-state copy in HomeDetail — avoid matching tutorial scene text.
    await expect(mainWindow.getByText('Click + in sidebar to create a project')).toBeVisible({
      timeout: 10_000
    })
  })

  test('main process has correct app name', async ({ electronApp }) => {
    const appName = await electronApp.evaluate(async ({ app }) => app.name)
    expect(appName).toBe('slayzone')
  })

  test('does not create splash window in Playwright mode', async ({ electronApp }) => {
    const dataWindows = electronApp.windows().filter((w) => w.url().startsWith('data:'))
    expect(dataWindows).toHaveLength(0)
  })
})
