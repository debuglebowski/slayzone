import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  box,
  dragTo,
  layoutBoxes,
  layoutOf,
  openTaskWithLayout,
  panel,
  settled,
  shapeOf,
  storedLayout,
  strip,
  stripTabs,
  tab
} from '../fixtures/task-layout'

// Tab strip drag and drop (docs/plans/panel-model.md step 8). A drop on a group's
// middle merges as a tab; its outer 20% left/right opens a new column, its outer
// 30% top/bottom a new slot; a strip takes the tab at the marker's index. While
// dragging nothing moves — only the target zone is outlined.

/** Agent alone on the left; a group of Editor + Settings tabs on the right. */
const START = layoutOf([
  { id: 'terminal', slots: [{ id: 'terminal', tabs: ['terminal'] }] },
  { id: 'right', slots: [{ id: 's-group', tabs: ['editor', 'settings'] }] }
])

test.describe('Layout tab drag and drop', () => {
  let projectId = ''
  let n = 0

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const p = await seed(mainWindow).createProject({
      name: 'Tabs DnD',
      color: '#a855f7',
      path: TEST_PROJECT_PATH
    })
    projectId = p.id
  })

  const open = (page: import('@playwright/test').Page) =>
    openTaskWithLayout(page, projectId, `DnD ${++n}`, START, ['terminal', 'editor'])

  test('nothing moves while dragging; the zone is outlined; drop splits right', async ({
    mainWindow: page
  }) => {
    const taskId = await open(page)
    await expect.poll(() => stripTabs(page, 's-group')).toEqual(['editor', 'settings'])
    const before = await layoutBoxes(page)

    await dragTo(page, tab(page, 'settings'), panel(page, 'terminal'), 0.92, 0.5, async () => {
      const indicator = page.locator('[data-testid="layout-drop-indicator"]')
      await expect(indicator).toHaveAttribute('data-drop', 'right')
      await expect(indicator).toHaveAttribute('data-drop-slot', 'terminal')
      await expect(page.locator('[data-testid="layout-drag-chip"]')).toContainText('Settings')
      // Nothing in the layout moved or resized.
      expect(await layoutBoxes(page)).toEqual(before)
    })

    await expect(page.locator('[data-testid="layout-drop-indicator"]')).toHaveCount(0)
    await expect
      .poll(async () => shapeOf(await storedLayout(page, taskId)))
      .toEqual([[['terminal']], [['settings']], [['editor']]])
    await settled(page)
    // Settings now has its own column between the agent and the editor; no strip is left.
    await expect(strip(page).locator('[data-tabstrip]')).toHaveCount(0)
    const t = await box(panel(page, 'terminal'))
    const s = await box(panel(page, 'settings'))
    const e = await box(panel(page, 'editor'))
    expect(s.x).toBeGreaterThan(t.x + t.width - 1)
    expect(e.x).toBeGreaterThan(s.x + s.width - 1)
  })

  test('a drop on the middle merges as a tab', async ({ mainWindow: page }) => {
    const taskId = await open(page)
    await dragTo(page, tab(page, 'settings'), panel(page, 'terminal'), 0.5, 0.5, async () => {
      await expect(page.locator('[data-testid="layout-drop-indicator"]')).toHaveAttribute(
        'data-drop',
        'merge'
      )
    })
    await expect.poll(() => stripTabs(page, 'terminal')).toEqual(['terminal', 'settings'])
    await expect(tab(page, 'settings')).toHaveAttribute('aria-selected', 'true')
    await expect(panel(page, 'settings')).toBeVisible()
    // The agent stays mounted behind its tab.
    await expect(panel(page, 'terminal')).toBeHidden()
    await expect
      .poll(async () => shapeOf(await storedLayout(page, taskId)))
      .toEqual([[['terminal', 'settings']], [['editor']]])
    // Clicking the agent's tab shows it again.
    await tab(page, 'terminal').click()
    await expect(panel(page, 'terminal')).toBeVisible()
    await expect(panel(page, 'settings')).toBeHidden()
  })

  test('the left edge opens a column before the group', async ({ mainWindow: page }) => {
    const taskId = await open(page)
    await dragTo(page, tab(page, 'settings'), panel(page, 'terminal'), 0.08, 0.5)
    await expect
      .poll(async () => shapeOf(await storedLayout(page, taskId)))
      .toEqual([[['settings']], [['terminal']], [['editor']]])
    await settled(page)
    const s = await box(panel(page, 'settings'))
    const t = await box(panel(page, 'terminal'))
    expect(t.x).toBeGreaterThan(s.x + s.width - 1)
  })

  test('the top edge stacks a slot above the group', async ({ mainWindow: page }) => {
    const taskId = await open(page)
    await dragTo(page, tab(page, 'settings'), panel(page, 'terminal'), 0.5, 0.1)
    await expect
      .poll(async () => shapeOf(await storedLayout(page, taskId)))
      .toEqual([[['settings'], ['terminal']], [['editor']]])
    await settled(page)
    const s = await box(panel(page, 'settings'))
    const t = await box(panel(page, 'terminal'))
    expect(t.y).toBeGreaterThan(s.y + s.height - 1)
    expect(Math.abs(t.x - s.x)).toBeLessThanOrEqual(1)
  })

  test('the bottom edge stacks a slot below the group', async ({ mainWindow: page }) => {
    const taskId = await open(page)
    await dragTo(page, tab(page, 'settings'), panel(page, 'terminal'), 0.5, 0.9)
    await expect
      .poll(async () => shapeOf(await storedLayout(page, taskId)))
      .toEqual([[['terminal'], ['settings']], [['editor']]])
    await settled(page)
    const s = await box(panel(page, 'settings'))
    const t = await box(panel(page, 'terminal'))
    expect(s.y).toBeGreaterThan(t.y + t.height - 1)
  })

  test('tabs reorder within their strip by drag, without an edit mode', async ({
    mainWindow: page
  }) => {
    const taskId = await open(page)
    const before = await layoutBoxes(page)
    await dragTo(page, tab(page, 'editor'), tab(page, 'settings'), 0.9, 0.5, async () => {
      const marker = page.locator('[data-testid="layout-drop-indicator"]')
      await expect(marker).toHaveAttribute('data-drop', 'mark')
      expect(await layoutBoxes(page)).toEqual(before)
    })
    await expect.poll(() => stripTabs(page, 's-group')).toEqual(['settings', 'editor'])
    await expect
      .poll(async () => shapeOf(await storedLayout(page, taskId)))
      .toEqual([[['terminal']], [['settings', 'editor']]])
  })

  test('the strip moves the whole group', async ({ mainWindow: page }) => {
    const taskId = await open(page)
    const groupStrip = strip(page).locator('[data-tabstrip="s-group"]')
    const s = await box(groupStrip)
    const t = await box(tab(page, 'settings'))
    // Press on the strip's empty part, right of the last tab.
    const sx = Math.min(s.x + s.width - 4, t.x + t.width + 20)
    const sy = s.y + s.height / 2
    const target = await box(panel(page, 'terminal'))
    await page.mouse.move(sx, sy)
    await page.mouse.down()
    await page.mouse.move(sx - 12, sy, { steps: 4 })
    await page.mouse.move(target.x + target.width * 0.08, target.y + target.height / 2, {
      steps: 12
    })
    await page.mouse.move(target.x + target.width * 0.08 + 1, target.y + target.height / 2)
    await page.mouse.up()
    await expect
      .poll(async () => shapeOf(await storedLayout(page, taskId)))
      .toEqual([[['editor', 'settings']], [['terminal']]])
  })

  test('the panel toggle menu adds a Classic panel to another group as a tab', async ({
    mainWindow: page
  }) => {
    const taskId = await openTaskWithLayout(
      page,
      projectId,
      `DnD ${++n}`,
      layoutOf([
        { id: 'terminal', slots: [{ id: 'terminal', tabs: ['terminal'] }] },
        { id: 'settings', slots: [{ id: 'settings', tabs: ['settings'] }] }
      ]),
      ['terminal', 'settings']
    )
    await expect(strip(page).locator('[data-tabstrip]')).toHaveCount(0)
    await page.locator('button[aria-pressed="true"]:visible', { hasText: 'Settings' }).click({
      button: 'right'
    })
    await page.getByRole('menuitem', { name: 'Agent' }).click()
    await expect.poll(() => stripTabs(page, 'terminal')).toEqual(['terminal', 'settings'])
    await expect
      .poll(async () => shapeOf(await storedLayout(page, taskId)))
      .toEqual([[['terminal', 'settings']]])
  })
})
