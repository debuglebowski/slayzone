import { test, expect, seed, goHome, clickProject, resetApp } from './fixtures/electron'
import { TEST_PROJECT_PATH } from './fixtures/electron'

test.describe.serial('Custom keyboard shortcuts', () => {
  let projectAbbrev: string

  const openShortcutsDialog = async (mainWindow: import('@playwright/test').Page) => {
    await mainWindow.locator('button[aria-label="Keyboard Shortcuts"]').click()
    await expect(mainWindow.getByRole('dialog')).toBeVisible({ timeout: 3_000 })
  }

  const closeDialog = async (mainWindow: import('@playwright/test').Page) => {
    await mainWindow.keyboard.press('Escape')
    await mainWindow.waitForTimeout(200)
  }

  const rebindShortcut = async (mainWindow: import('@playwright/test').Page, label: string, newKeys: string) => {
    await openShortcutsDialog(mainWindow)
    // Find the label span, go up to the row, then click the key badge
    const labelSpan = mainWindow.getByRole('dialog').locator(`span.text-sm:text-is("${label}")`).first()
    // The key badge is a sibling span with cursor-pointer in the same flex row
    const keyBadge = labelSpan.locator('..').locator('span.cursor-pointer')
    await keyBadge.click()
    await expect(mainWindow.getByText('Press keys...')).toBeVisible({ timeout: 2_000 })
    await mainWindow.keyboard.press(newKeys)
    await closeDialog(mainWindow)
  }

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Shortcuts Test', color: '#06b6d4', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    await s.createTask({ projectId: p.id, title: 'Shortcut task', status: 'in_progress' })
    await s.refreshData()
    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.locator('h3').getByText('Inbox', { exact: true })).toBeVisible({ timeout: 5_000 })
  })

  test('opens shortcuts dialog via sidebar button', async ({ mainWindow }) => {
    await openShortcutsDialog(mainWindow)
    await expect(mainWindow.getByRole('heading', { name: 'Keyboard Shortcuts' })).toBeVisible()
    await closeDialog(mainWindow)
  })

  test('rebind search shortcut and verify it works', async ({ mainWindow }) => {
    await rebindShortcut(mainWindow, 'Search', 'Meta+Shift+p')

    // Press the NEW shortcut — should open search
    await mainWindow.keyboard.press('Meta+Shift+p')
    await expect(mainWindow.getByPlaceholder('Search tasks and projects...')).toBeVisible({ timeout: 3_000 })
    await mainWindow.keyboard.press('Escape')

    // Press the OLD shortcut — should NOT open search
    await mainWindow.keyboard.press('Meta+k')
    await mainWindow.waitForTimeout(500)
    await expect(mainWindow.getByPlaceholder('Search tasks and projects...')).not.toBeVisible()
  })

  test('reset to defaults restores original shortcuts', async ({ mainWindow }) => {
    await openShortcutsDialog(mainWindow)
    await mainWindow.getByText('Reset to Defaults').click()
    await closeDialog(mainWindow)

    // Original Cmd+K should work again
    await mainWindow.keyboard.press('Meta+k')
    await expect(mainWindow.getByPlaceholder('Search tasks and projects...')).toBeVisible({ timeout: 3_000 })
    await mainWindow.keyboard.press('Escape')
  })

  test('shortcut persists after page reload', async ({ mainWindow }) => {
    await rebindShortcut(mainWindow, 'Search', 'Meta+Shift+p')

    // Reload the page
    await mainWindow.reload({ waitUntil: 'domcontentloaded' })
    await mainWindow.waitForSelector('#root', { timeout: 10_000 })
    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.locator('h3').getByText('Inbox', { exact: true })).toBeVisible({ timeout: 5_000 })

    // Custom shortcut should still work
    await mainWindow.keyboard.press('Meta+Shift+p')
    await expect(mainWindow.getByPlaceholder('Search tasks and projects...')).toBeVisible({ timeout: 3_000 })
    await mainWindow.keyboard.press('Escape')

    // Clean up: reset to defaults
    await openShortcutsDialog(mainWindow)
    await mainWindow.getByText('Reset to Defaults').click()
    await closeDialog(mainWindow)
  })
})
