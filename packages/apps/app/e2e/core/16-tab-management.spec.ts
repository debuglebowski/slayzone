import { test, expect, seed, goHome, clickProject, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'

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

/** Read the title of the currently-active tab from the tab store. Task tabs
 *  stay mounted (display:none) so all their <input>s remain visible per the
 *  layout; only the store knows which one is actually active. */
async function getActiveTabTitle(page: import('@playwright/test').Page): Promise<string | null> {
  return page.evaluate(() => {
    const s = (window as any).__slayzone_tabStore.getState()
    return s.tabs[s.activeTabIndex]?.title ?? null
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
      const store = (window as any).__slayzone_tabStore.getState()
      store.closeTab(store.activeTabIndex)
    })
    await expect
      .poll(
        async () => {
          return await mainWindow
            .evaluate(() =>
              (window as any).__slayzone_tabStore
                .getState()
                .tabs.some(
                  (tab: { type: string; title?: string }) =>
                    tab.type === 'task' && tab.title === 'Tab task C'
                )
            )
            .catch(() => false)
        },
        { timeout: 5_000 }
      )
      .toBe(false)

    await mainWindow.evaluate(() => {
      ;(window as any).__slayzone_tabStore.getState().reopenClosedTab()
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

  test('Cmd+Option+Right cycles forward through task tabs and wraps', async ({ mainWindow }) => {
    // Ensure all 3 task tabs (A, B, C) are open, then start on the first one.
    for (const title of ['Tab task A', 'Tab task B', 'Tab task C']) {
      await goHome(mainWindow)
      await expect(mainWindow.getByText(title).first()).toBeVisible({ timeout: 5_000 })
      await mainWindow.getByText(title).first().click()
      await expect(
        mainWindow.locator('[data-testid="terminal-mode-trigger"]:visible').first()
      ).toBeVisible({ timeout: 5_000 })
    }
    await mainWindow.keyboard.press('Meta+1')
    await expect(
      mainWindow.locator('[data-testid="terminal-mode-trigger"]:visible').first()
    ).toBeVisible({ timeout: 5_000 })
    expect(await getActiveTabTitle(mainWindow)).toBe('Tab task A')

    await mainWindow.keyboard.press('Meta+Alt+ArrowRight')
    expect(await getActiveTabTitle(mainWindow)).toBe('Tab task B')

    await mainWindow.keyboard.press('Meta+Alt+ArrowRight')
    expect(await getActiveTabTitle(mainWindow)).toBe('Tab task C')

    // Wrap-around: last → first
    await mainWindow.keyboard.press('Meta+Alt+ArrowRight')
    expect(await getActiveTabTitle(mainWindow)).toBe('Tab task A')
  })

  test('Cmd+Option+Left cycles backward through task tabs and wraps', async ({ mainWindow }) => {
    await mainWindow.keyboard.press('Meta+1')
    await expect(
      mainWindow.locator('[data-testid="terminal-mode-trigger"]:visible').first()
    ).toBeVisible({ timeout: 5_000 })
    expect(await getActiveTabTitle(mainWindow)).toBe('Tab task A')

    // Wrap-around: first → last
    await mainWindow.keyboard.press('Meta+Alt+ArrowLeft')
    expect(await getActiveTabTitle(mainWindow)).toBe('Tab task C')

    await mainWindow.keyboard.press('Meta+Alt+ArrowLeft')
    expect(await getActiveTabTitle(mainWindow)).toBe('Tab task B')

    await mainWindow.keyboard.press('Meta+Alt+ArrowLeft')
    expect(await getActiveTabTitle(mainWindow)).toBe('Tab task A')
  })

  test('Cmd+Option+Right is suppressed while focused in a text input', async ({ mainWindow }) => {
    await mainWindow.keyboard.press('Meta+1')
    await expect(
      mainWindow.locator('[data-testid="terminal-mode-trigger"]:visible').first()
    ).toBeVisible({ timeout: 5_000 })
    expect(await getActiveTabTitle(mainWindow)).toBe('Tab task A')

    // Focus the visible task title input (an <input>) — guard should NOT switch tabs.
    const titleInput = mainWindow.locator('input:visible').first()
    await titleInput.focus()
    await mainWindow.keyboard.press('Meta+Alt+ArrowRight')

    // Active task tab is unchanged.
    expect(await getActiveTabTitle(mainWindow)).toBe('Tab task A')
  })

  test('Cmd+3 jumps to the 3rd task tab; Cmd+9 is a no-op when fewer than 9 tabs', async ({
    mainWindow
  }) => {
    // With 3 task tabs open, Cmd+N is an indexed jump (Cmd+N → Nth task tab).
    await mainWindow.keyboard.press('Meta+1')
    await expect(
      mainWindow.locator('[data-testid="terminal-mode-trigger"]:visible').first()
    ).toBeVisible({ timeout: 5_000 })
    expect(await getActiveTabTitle(mainWindow)).toBe('Tab task A')

    await mainWindow.keyboard.press('Meta+3')
    expect(await getActiveTabTitle(mainWindow)).toBe('Tab task C')

    // Cmd+9 with only 3 task tabs open is a no-op (no 9th tab to jump to).
    await mainWindow.keyboard.press('Meta+9')
    expect(await getActiveTabTitle(mainWindow)).toBe('Tab task C')
  })

  test('Cmd+Option+Right/Left from home jumps to first / last task tab', async ({ mainWindow }) => {
    await goHome(mainWindow)
    // Home tab active — next jumps to FIRST task tab.
    await mainWindow.keyboard.press('Meta+Alt+ArrowRight')
    expect(await getActiveTabTitle(mainWindow)).toBe('Tab task A')

    await goHome(mainWindow)
    // Home tab active — prev jumps to LAST task tab.
    await mainWindow.keyboard.press('Meta+Alt+ArrowLeft')
    expect(await getActiveTabTitle(mainWindow)).toBe('Tab task C')
  })
})
