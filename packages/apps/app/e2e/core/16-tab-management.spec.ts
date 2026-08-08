import { test, expect, seed, goHome, clickProject, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'

/**
 * The renderer exposes the zustand tab store on `window` purely for E2E driving
 * (Meta+Shift+T and friends are flaky through the OS menu). Only the members
 * these tests actually call are declared.
 */
type TabStoreWindow = {
  __slayzone_tabStore: {
    getState: () => {
      tabs: { type: string; title?: string }[]
      activeTabIndex: number
      closeTab: (index: number) => void
      reopenClosedTab: () => void
    }
  }
}

/** Get the value of the first visible input on the page */
async function getVisibleInputValue(page: import('@playwright/test').Page): Promise<string | null> {
  return page.evaluate(() => {
    const inputs = document.querySelectorAll('input')
    for (const input of inputs) {
      if (input.offsetParent !== null && input.value) return input.value
    }
    return null
  })
}

test.describe('Tab management & keyboard shortcuts', () => {
  let projectAbbrev: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Shortcut Test',
      color: '#f59e0b',
      path: TEST_PROJECT_PATH
    })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()

    await s.createTask({ projectId: p.id, title: 'Tab task A', status: 'in_progress' })
    await s.createTask({ projectId: p.id, title: 'Tab task B', status: 'in_progress' })
    await s.createTask({ projectId: p.id, title: 'Tab task C', status: 'in_progress' })
    await s.refreshData()

    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.getByText('Tab task A').first()).toBeVisible({ timeout: 5_000 })
  })

  test('open multiple tasks as tabs', async ({ mainWindow }) => {
    await mainWindow.getByText('Tab task A').first().click()
    await expect(
      mainWindow.locator('[data-testid="terminal-mode-trigger"]:visible').first()
    ).toBeVisible({ timeout: 5_000 })

    await goHome(mainWindow)
    await expect(mainWindow.getByText('Tab task A').first()).toBeVisible({ timeout: 5_000 })
    await mainWindow.getByText('Tab task B').first().click()
    await expect(
      mainWindow.locator('[data-testid="terminal-mode-trigger"]:visible').first()
    ).toBeVisible({ timeout: 5_000 })

    await goHome(mainWindow)
    await expect(mainWindow.getByText('Tab task B').first()).toBeVisible({ timeout: 5_000 })
    await mainWindow.getByText('Tab task C').first().click()
    await expect(
      mainWindow.locator('[data-testid="terminal-mode-trigger"]:visible').first()
    ).toBeVisible({ timeout: 5_000 })

    // All tasks should be in DOM (tab bar + content)
    await expect(mainWindow.getByText('Tab task A').first()).toBeAttached()
    await expect(mainWindow.getByText('Tab task B').first()).toBeAttached()
    await expect(mainWindow.getByText('Tab task C').first()).toBeAttached()
  })

  test('Cmd+1 switches to first task tab', async ({ mainWindow }) => {
    // Cmd+N maps to index N, so Cmd+1 = index 1 = first task tab
    await goHome(mainWindow)
    await expect(mainWindow.getByText('Tab task A').first()).toBeVisible({ timeout: 5_000 })

    await mainWindow.keyboard.press('Meta+1')
    await expect(
      mainWindow.locator('[data-testid="terminal-mode-trigger"]:visible').first()
    ).toBeVisible({ timeout: 5_000 })

    // Should be on a task tab (visible input with a title)
    const value = await getVisibleInputValue(mainWindow)
    expect(value).toBeTruthy()
  })

  test('Cmd+2 switches to second task tab', async ({ mainWindow }) => {
    await mainWindow.keyboard.press('Meta+2')
    await expect(
      mainWindow.locator('[data-testid="terminal-mode-trigger"]:visible').first()
    ).toBeVisible({ timeout: 5_000 })

    const value = await getVisibleInputValue(mainWindow)
    expect(value).toBeTruthy()
  })

  test('Ctrl+Tab cycles to next tab', async ({ mainWindow }) => {
    await goHome(mainWindow)
    await expect(mainWindow.getByText('Tab task A').first()).toBeVisible({ timeout: 5_000 })

    await mainWindow.keyboard.press('Control+Tab')
    await expect(
      mainWindow.locator('[data-testid="terminal-mode-trigger"]:visible').first()
    ).toBeVisible({ timeout: 5_000 })

    // Should be on a task tab (visible input with a title)
    const value = await getVisibleInputValue(mainWindow)
    expect(value).toBeTruthy()
  })

  test('Ctrl+Shift+Tab cycles backward', async ({ mainWindow }) => {
    await mainWindow.keyboard.press('Control+Shift+Tab')

    // Should cycle backward — back to home tab
    await expect(mainWindow.locator('h3').getByText('Inbox', { exact: true })).toBeAttached({
      timeout: 3_000
    })
  })

  test('reopens closed tab', async ({ mainWindow }) => {
    // Open a known task tab directly
    await goHome(mainWindow)
    await expect(mainWindow.getByText('Tab task C').first()).toBeVisible({ timeout: 5_000 })
    await mainWindow.getByText('Tab task C').first().click()
    await expect(
      mainWindow.locator('[data-testid="terminal-mode-trigger"]:visible').first()
    ).toBeVisible({ timeout: 5_000 })

    const closedTitle = await getVisibleInputValue(mainWindow)
    expect(closedTitle).toBeTruthy()

    await mainWindow.evaluate(() => {
      const store = (window as unknown as TabStoreWindow).__slayzone_tabStore.getState()
      store.closeTab(store.activeTabIndex)
    })
    await expect
      .poll(
        async () => {
          return await mainWindow
            .evaluate(() =>
              (window as unknown as TabStoreWindow).__slayzone_tabStore
                .getState()
                .tabs.some((tab) => tab.type === 'task' && tab.title === 'Tab task C')
            )
            .catch(() => false)
        },
        { timeout: 5_000 }
      )
      .toBe(false)

    await mainWindow.evaluate(() => {
      ;(window as unknown as TabStoreWindow).__slayzone_tabStore.getState().reopenClosedTab()
    })
    await expect(
      mainWindow.locator('[data-testid="terminal-mode-trigger"]:visible').first()
    ).toBeVisible({ timeout: 5_000 })

    const reopenedTitle = await getVisibleInputValue(mainWindow)
    expect(reopenedTitle).toBe(closedTitle)
  })

  test('opening same task twice does not duplicate tab', async ({ mainWindow }) => {
    await goHome(mainWindow)
    await expect(mainWindow.getByText('Tab task A').first()).toBeVisible({ timeout: 5_000 })

    await mainWindow.getByText('Tab task A').first().click()
    await expect(
      mainWindow.locator('[data-testid="terminal-mode-trigger"]:visible').first()
    ).toBeVisible({ timeout: 5_000 })

    await goHome(mainWindow)
    await expect(mainWindow.getByText('Tab task A').first()).toBeVisible({ timeout: 5_000 })
    await mainWindow.getByText('Tab task A').first().click()
    await expect(
      mainWindow.locator('[data-testid="terminal-mode-trigger"]:visible').first()
    ).toBeVisible({ timeout: 5_000 })

    const value = await getVisibleInputValue(mainWindow)
    expect(value).toBe('Tab task A')
  })
})
