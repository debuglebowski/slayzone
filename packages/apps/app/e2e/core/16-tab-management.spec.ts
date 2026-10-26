import type { Page } from '@playwright/test'
import {
  test,
  expect,
  seed,
  goHome,
  clickProject,
  resetApp,
  openTaskById
} from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import { waitForPtySession } from '../fixtures/terminal'

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

/** Task-tab titles in tab-bar order. */
function getTaskTabTitles(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as unknown as TabStoreWindow).__slayzone_tabStore
      .getState()
      .tabs.flatMap((tab) => (tab.type === 'task' ? [tab.title ?? ''] : []))
  )
}

/** The active tab's title, or null when the active tab is home. */
function getActiveTaskTabTitle(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const s = (window as unknown as TabStoreWindow).__slayzone_tabStore.getState()
    const tab = s.tabs[s.activeTabIndex]
    return tab?.type === 'task' ? (tab.title ?? '') : null
  })
}

function expectActiveTaskTab(page: Page, title: string): Promise<void> {
  return expect.poll(() => getActiveTaskTabTitle(page), { timeout: 3_000 }).toBe(title)
}

test.describe('Tab management & keyboard shortcuts', () => {
  let projectAbbrev: string
  let projectId: string
  const taskIds: string[] = []

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Shortcut Test',
      color: '#f59e0b',
      path: TEST_PROJECT_PATH
    })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    projectId = p.id

    for (const title of ['Tab task A', 'Tab task B', 'Tab task C']) {
      const task = await s.createTask({ projectId: p.id, title, status: 'in_progress' })
      taskIds.push(task.id)
    }
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

  // ⌘⌥← / ⌘⌥→ (#98): the task tab physically left/right in the tab bar, wrapping at
  // the edges, skipping the home tab.
  test('Cmd+Option+Right/Left switch to the adjacent task tab, wrapping at the edges', async ({
    mainWindow
  }) => {
    for (const id of taskIds) await openTaskById(mainWindow, id)
    const order = await getTaskTabTitles(mainWindow)
    expect(order).toHaveLength(3)

    await mainWindow.keyboard.press('Meta+1')
    await expectActiveTaskTab(mainWindow, order[0])

    for (const title of [order[1], order[2], order[0]]) {
      await mainWindow.keyboard.press('Meta+Alt+ArrowRight')
      await expectActiveTaskTab(mainWindow, title)
    }
    for (const title of [order[2], order[1], order[0]]) {
      await mainWindow.keyboard.press('Meta+Alt+ArrowLeft')
      await expectActiveTaskTab(mainWindow, title)
    }
  })

  test('from the home tab, Cmd+Option+Right opens the first task tab, Left the last', async ({
    mainWindow
  }) => {
    for (const id of taskIds) await openTaskById(mainWindow, id)
    const order = await getTaskTabTitles(mainWindow)

    await goHome(mainWindow)
    await mainWindow.keyboard.press('Meta+Alt+ArrowRight')
    await expectActiveTaskTab(mainWindow, order[0])

    await goHome(mainWindow)
    await mainWindow.keyboard.press('Meta+Alt+ArrowLeft')
    await expectActiveTaskTab(mainWindow, order[order.length - 1])
  })

  // ⌘⌥←/→ is not text navigation (⌥←/→ is), and a task's terminal holds focus almost
  // permanently — so the shortcut must work from a focused text field and terminal.
  test('Cmd+Option+Right works with focus in a text field', async ({ mainWindow }) => {
    for (const id of taskIds) await openTaskById(mainWindow, id)
    const order = await getTaskTabTitles(mainWindow)
    await mainWindow.keyboard.press('Meta+1')
    await expectActiveTaskTab(mainWindow, order[0])

    // The active task's title field. Polled: the pane is revealed a frame after the
    // tab switch (deferred active index), and a hidden input has no offsetParent.
    await expect
      .poll(() =>
        mainWindow.evaluate((title) => {
          const input = [...document.querySelectorAll('input')].find(
            (el) => el.offsetParent !== null && el.value === title
          )
          input?.focus()
          return !!input && document.activeElement === input
        }, order[0])
      )
      .toBe(true)

    await mainWindow.keyboard.press('Meta+Alt+ArrowRight')
    await expectActiveTaskTab(mainWindow, order[1])
  })

  test('Cmd+Option+Right works with focus in a terminal', async ({ mainWindow }) => {
    const scratch = await seed(mainWindow).createTask({
      projectId,
      title: 'Tab scratch',
      status: 'in_progress',
      isTemporary: true,
      terminalMode: 'terminal'
    })
    await seed(mainWindow).refreshData()
    for (const id of taskIds) await openTaskById(mainWindow, id)
    await openTaskById(mainWindow, scratch.id)
    await waitForPtySession(mainWindow, `${scratch.id}:${scratch.id}`)

    const order = await getTaskTabTitles(mainWindow)
    const from = order.indexOf((await getActiveTaskTabTitle(mainWindow)) ?? '')
    expect(from).toBeGreaterThanOrEqual(0)
    const target = order[(from + 1) % order.length]
    expect(target).not.toBe(order[from])

    await mainWindow.locator('.xterm:visible').first().click()
    await expect
      .poll(() => mainWindow.evaluate(() => !!document.activeElement?.closest('.xterm')))
      .toBe(true)

    await mainWindow.keyboard.press('Meta+Alt+ArrowRight')
    await expectActiveTaskTab(mainWindow, target)
  })
})
