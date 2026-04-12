import { test, expect, seed, goHome, clickProject, resetApp} from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import { focusForAppShortcut } from '../fixtures/browser-view'
import { shortcutKey } from '../fixtures/shortcuts'

test.describe('Panel toggles', () => {
  let projectAbbrev: string
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Panel Test', color: '#3b82f6', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    const t = await s.createTask({ projectId: p.id, title: 'Panel toggle task', status: 'todo' })
    taskId = t.id
    await s.refreshData()

    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.getByText('Panel toggle task').first()).toBeVisible({ timeout: 5_000 })

    // Open task detail
    await mainWindow.getByText('Panel toggle task').first().click()
    await expect(panelBtn(mainWindow, 'Terminal')).toBeVisible({ timeout: 5_000 })
  })

  /** Scope to visible PanelToggle buttons in the active task tab */
  const panelBtn = (page: import('@playwright/test').Page, label: string) =>
    page.locator('.bg-surface-2.rounded-lg:visible').filter({ has: page.locator('button:has-text("Terminal")') }).locator(`button:has-text("${label}")`)

  const isPanelActive = async (page: import('@playwright/test').Page, label: string) => {
    const className = await panelBtn(page, label).getAttribute('class')
    return /(?:^|\s)bg-surface-3(?:\s|$)/.test(className ?? '')
  }

  const toggleByShortcut = async (
    page: import('@playwright/test').Page,
    shortcut: string,
    label: string,
    expectedActive: boolean
  ) => {
    await expect.poll(async () => {
      if ((await isPanelActive(page, label)) === expectedActive) return true
      await focusForAppShortcut(page)
      await page.waitForTimeout(100)
      await page.keyboard.press(shortcut)
      await page.waitForTimeout(150)
      return (await isPanelActive(page, label)) === expectedActive
    }, { timeout: 5_000 }).toBe(true)
  }

  test('default panels: terminal + settings active, browser + diff inactive', async ({ mainWindow }) => {
    await expect(panelBtn(mainWindow, 'Terminal')).toHaveClass(/bg-surface-3/)
    await expect(panelBtn(mainWindow, 'Settings')).toHaveClass(/bg-surface-3/)
    await expect(panelBtn(mainWindow, 'Browser')).not.toHaveClass(/(?:^|\s)bg-surface-3(?:\s|$)/)
    await expect(panelBtn(mainWindow, 'Git')).not.toHaveClass(/(?:^|\s)bg-surface-3(?:\s|$)/)
  })

  test('terminal panel shortcut toggles terminal off', async ({ mainWindow }) => {
    await toggleByShortcut(mainWindow, shortcutKey('panel-terminal'), 'Terminal', false)
  })

  test('browser panel shortcut toggles browser on', async ({ mainWindow }) => {
    await toggleByShortcut(mainWindow, shortcutKey('panel-browser'), 'Browser', true)
  })

  test('git panel shortcut toggles diff on', async ({ mainWindow }) => {
    await toggleByShortcut(mainWindow, shortcutKey('panel-git'), 'Git', true)
  })

  test('settings panel shortcut toggles settings off', async ({ mainWindow }) => {
    await toggleByShortcut(mainWindow, shortcutKey('panel-settings'), 'Settings', false)
  })

  test('click PanelToggle button toggles panel', async ({ mainWindow }) => {
    // Terminal is currently off — click to turn on
    await panelBtn(mainWindow, 'Terminal').click()
    await expect(panelBtn(mainWindow, 'Terminal')).toHaveClass(/bg-surface-3/)
  })

  test('panel visibility persists across navigation', async ({ mainWindow }) => {
    // Current state: terminal=on, browser=on, diff=on, settings=off
    // Navigate away
    await goHome(mainWindow)

    // Reopen the same task
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.getByText('Panel toggle task').first()).toBeVisible({ timeout: 5_000 })
    await mainWindow.getByText('Panel toggle task').first().click()
    await expect(panelBtn(mainWindow, 'Terminal')).toBeVisible({ timeout: 5_000 })

    // Verify persisted state
    await expect(panelBtn(mainWindow, 'Terminal')).toHaveClass(/bg-surface-3/)
    await expect(panelBtn(mainWindow, 'Browser')).toHaveClass(/bg-surface-3/)
    await expect(panelBtn(mainWindow, 'Git')).toHaveClass(/bg-surface-3/)
    await expect(panelBtn(mainWindow, 'Settings')).not.toHaveClass(/(?:^|\s)bg-surface-3(?:\s|$)/)
  })
})
