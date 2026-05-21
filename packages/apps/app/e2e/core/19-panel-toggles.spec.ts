import { test, expect, seed, goHome, clickProject, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import { focusForAppShortcut } from '../fixtures/browser-view'
import { shortcutKey } from '../fixtures/shortcuts'

test.describe('Panel toggles', () => {
  let projectAbbrev: string
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Panel Test',
      color: '#3b82f6',
      path: TEST_PROJECT_PATH
    })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    const t = await s.createTask({ projectId: p.id, title: 'Panel toggle task', status: 'todo' })
    taskId = t.id
    await s.refreshData()

    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.getByText('Panel toggle task').first()).toBeVisible({ timeout: 5_000 })

    // Open task detail
    await mainWindow.getByText('Panel toggle task').first().click()
    await expect(panelBtn(mainWindow, 'Agent')).toBeVisible({ timeout: 5_000 })
  })

  /** Scope to visible PanelToggle buttons in the active task tab */
  const panelBtn = (page: import('@playwright/test').Page, label: string) =>
    page
      .locator('.bg-surface-2.rounded-lg:visible')
      .filter({ has: page.locator('button:has-text("Agent")') })
      .locator(`button:has-text("${label}")`)

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
    await expect
      .poll(
        async () => {
          if ((await isPanelActive(page, label)) === expectedActive) return true
          await focusForAppShortcut(page)
          await page.waitForTimeout(100)
          await page.keyboard.press(shortcut)
          await page.waitForTimeout(150)
          return (await isPanelActive(page, label)) === expectedActive
        },
        { timeout: 5_000 }
      )
      .toBe(true)
  }

  test('default panels: terminal + settings active, browser + diff inactive', async ({
    mainWindow
  }) => {
    await expect(panelBtn(mainWindow, 'Agent')).toHaveClass(/bg-surface-3/)
    await expect(panelBtn(mainWindow, 'Settings')).toHaveClass(/bg-surface-3/)
    await expect(panelBtn(mainWindow, 'Browser')).not.toHaveClass(/(?:^|\s)bg-surface-3(?:\s|$)/)
    await expect(panelBtn(mainWindow, 'Git')).not.toHaveClass(/(?:^|\s)bg-surface-3(?:\s|$)/)
  })

  test('terminal panel shortcut toggles terminal off', async ({ mainWindow }) => {
    await toggleByShortcut(mainWindow, shortcutKey('panel-terminal'), 'Agent', false)
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
    await panelBtn(mainWindow, 'Agent').click()
    await expect(panelBtn(mainWindow, 'Agent')).toHaveClass(/bg-surface-3/)
  })

  /** Ordered labels of the visible PanelToggle buttons in the active task tab */
  const buttonOrder = async (page: import('@playwright/test').Page) => {
    const container = page
      .locator('.bg-surface-2.rounded-lg:visible')
      .filter({ has: page.locator('button:has-text("Agent")') })
    const texts = await container.locator('button').allInnerTexts()
    return texts.map((t) => t.trim().split(/\s|⌘/)[0])
  }

  /** Drag one panel toggle button onto another (dnd-kit, 6px activation threshold) */
  const dragButton = async (
    page: import('@playwright/test').Page,
    fromLabel: string,
    toLabel: string
  ) => {
    const fb = await panelBtn(page, fromLabel).boundingBox()
    const tb = await panelBtn(page, toLabel).boundingBox()
    if (!fb || !tb) throw new Error('panel button not found')
    await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2)
    await page.mouse.down()
    // move past the 6px activation threshold, then onto the target
    await page.mouse.move(fb.x + fb.width / 2 + 12, fb.y + fb.height / 2, { steps: 5 })
    await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 12 })
    await page.mouse.move(tb.x + tb.width / 2 + 1, tb.y + tb.height / 2, { steps: 3 })
    await page.mouse.up()
  }

  test('panel visibility persists across navigation', async ({ mainWindow }) => {
    // Current state: terminal=on, browser=on, diff=on, settings=off
    // Navigate away
    await goHome(mainWindow)

    // Reopen the same task
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.getByText('Panel toggle task').first()).toBeVisible({ timeout: 5_000 })
    await mainWindow.getByText('Panel toggle task').first().click()
    await expect(panelBtn(mainWindow, 'Agent')).toBeVisible({ timeout: 5_000 })

    // Verify persisted state
    await expect(panelBtn(mainWindow, 'Agent')).toHaveClass(/bg-surface-3/)
    await expect(panelBtn(mainWindow, 'Browser')).toHaveClass(/bg-surface-3/)
    await expect(panelBtn(mainWindow, 'Git')).toHaveClass(/bg-surface-3/)
    await expect(panelBtn(mainWindow, 'Settings')).not.toHaveClass(/(?:^|\s)bg-surface-3(?:\s|$)/)
  })

  test('drag-reorder moves a panel toggle button and persists to panel_config', async ({
    mainWindow
  }) => {
    const before = await buttonOrder(mainWindow)
    expect(before[0]).toBe('Agent')
    expect(before.indexOf('Git')).toBeGreaterThan(0)

    // Drag Agent (first) onto Git — Agent should land at Git's slot
    await dragButton(mainWindow, 'Agent', 'Git')

    await expect
      .poll(async () => {
        const order = await buttonOrder(mainWindow)
        return order.indexOf('Agent') > order.indexOf('Git')
      })
      .toBe(true)

    // Reorder writes the SAME setting the Settings modal uses: panel_config.order
    const savedOrder = await mainWindow.evaluate(async () => {
      const raw = await window.api.settings.get('panel_config')
      return raw ? (JSON.parse(raw).order as string[]) : null
    })
    expect(savedOrder).not.toBeNull()
    // 'git' is the order-id form of the 'diff' task panel
    expect(savedOrder!.indexOf('terminal')).toBeGreaterThan(savedOrder!.indexOf('git'))
  })

  test('reordered panels persist across navigation', async ({ mainWindow }) => {
    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.getByText('Panel toggle task').first()).toBeVisible({ timeout: 5_000 })
    await mainWindow.getByText('Panel toggle task').first().click()
    await expect(panelBtn(mainWindow, 'Agent')).toBeVisible({ timeout: 5_000 })

    const order = await buttonOrder(mainWindow)
    expect(order.indexOf('Agent')).toBeGreaterThan(order.indexOf('Git'))
  })

  test('plain click still toggles after drag support added', async ({ mainWindow }) => {
    const activeBefore = await isPanelActive(mainWindow, 'Browser')
    await panelBtn(mainWindow, 'Browser').click()
    await expect.poll(async () => isPanelActive(mainWindow, 'Browser')).toBe(!activeBefore)
  })
})
