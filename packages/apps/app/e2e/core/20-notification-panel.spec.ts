import { test, expect, seed, goHome, clickProject, resetApp} from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'

/** Toggle notification panel via bell button, waiting for state to settle */
const clickBell = async (page: import('@playwright/test').Page) => {
  // Use Playwright click on the button element wrapping the bell icon
  const bell = page.locator('button').filter({ has: page.locator('.lucide-bell') }).first()
  await bell.scrollIntoViewIfNeeded()
  await bell.click()
}

test.describe('Notification panel', () => {
  let projectAbbrev: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Notif Test', color: '#ef4444', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()

    await s.refreshData()

    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)

    // Ensure notification panel starts closed
    const panelText = mainWindow.getByText('No tasks need attention')
    if (await panelText.isVisible({ timeout: 500 }).catch(() => false)) {
      await clickBell(mainWindow)
      await expect(mainWindow.getByText('No tasks need attention')).not.toBeVisible({ timeout: 3_000 })
    }
  })

  test('bell icon visible in tab bar', async ({ mainWindow }) => {
    await expect(mainWindow.locator('button').filter({ has: mainWindow.locator('.lucide-bell') })).toBeVisible()
  })

  test('clicking bell opens notification side panel', async ({ mainWindow }) => {
    await clickBell(mainWindow)

    // Notification side panel has border-l and contains filter buttons
    const panel = mainWindow.locator('div.border-l.bg-background').last()
    await expect(panel).toBeVisible({ timeout: 5_000 })
    // Panel header has filter buttons
    await expect(panel.getByRole('button', { name: 'All' })).toBeVisible()
  })

  test('panel shows project filter button', async ({ mainWindow }) => {
    const panel = mainWindow.locator('div.border-l.bg-background').last()
    await expect(panel.getByRole('button', { name: 'Notif Test' })).toBeVisible()
  })

  test('clicking bell again hides panel', async ({ mainWindow }) => {
    await clickBell(mainWindow)

    const panel = mainWindow.locator('div.border-l.bg-background').last()
    await expect(panel).not.toBeVisible({ timeout: 5_000 })
  })

  test('Ctrl+. toggles notification panel', async ({ mainWindow }) => {
    // Open via shortcut
    await mainWindow.keyboard.press('Control+.')
    const panel = mainWindow.locator('div.border-l.bg-background').last()
    await expect(panel).toBeVisible({ timeout: 5_000 })

    // Close via shortcut
    await mainWindow.keyboard.press('Control+.')
    await expect(panel).not.toBeVisible({ timeout: 5_000 })
  })

  test('notification panel state persists to settings', async ({ mainWindow }) => {
    // Open panel
    await clickBell(mainWindow)
    const panel = mainWindow.locator('div.border-l.bg-background').last()
    await expect(panel).toBeVisible({ timeout: 5_000 })

    const raw = await seed(mainWindow).getSetting('notificationPanelState')
    const state = JSON.parse(raw!)
    expect(state.isLocked).toBe(true)

    // Close panel for cleanup
    await clickBell(mainWindow)
    await expect(panel).not.toBeVisible({ timeout: 5_000 })
  })
})

test.describe('Desktop notification toggle', () => {
  test('podcast icon visible next to bell', async ({ mainWindow }) => {
    await expect(mainWindow.locator('.lucide-podcast').first()).toBeVisible()
  })

  test('clicking podcast toggles desktop notifications on', async ({ mainWindow }) => {
    await mainWindow.locator('.lucide-podcast').first().click()

    await expect.poll(async () => {
      const raw = await seed(mainWindow).getSetting('notificationPanelState')
      return JSON.parse(raw!).desktopEnabled
    }, { timeout: 5_000 }).toBe(true)
  })

  test('clicking podcast again toggles desktop notifications off', async ({ mainWindow }) => {
    await mainWindow.locator('.lucide-podcast').first().click()

    await expect.poll(async () => {
      const raw = await seed(mainWindow).getSetting('notificationPanelState')
      return JSON.parse(raw!).desktopEnabled
    }, { timeout: 5_000 }).toBe(false)
  })
})
