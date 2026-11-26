import type { Page } from '@playwright/test'
import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import {
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

// Tab strip close / menu (docs/plans/panel-model.md steps 6 and 8): ×, ⌘W on the
// focused panel tab and the tab menu's Close hide a primary panel (it keeps its
// place); Hide does the same; Split down/right move the tab into a new slot or
// column; Rename names the tab.

const START = layoutOf([
  { id: 'terminal', slots: [{ id: 'terminal', tabs: ['terminal'] }] },
  { id: 'right', slots: [{ id: 's-group', tabs: ['editor', 'settings', 'diff'] }] }
])

/** Type of the active app tab (from the exposed store). */
async function activeTabType(page: Page): Promise<string> {
  return page.evaluate(() => {
    const state = (
      window as unknown as {
        __slayzone_tabStore?: {
          getState?: () => { tabs?: { type?: string }[]; activeTabIndex: number }
        }
      }
    ).__slayzone_tabStore?.getState?.()
    return String(state?.tabs?.[state.activeTabIndex]?.type ?? 'none')
  })
}

/** The ⌘W menu event, emitted only while a task tab is active (see 57-cmd-w-close). */
async function emitCloseCurrentFocus(page: Page): Promise<void> {
  expect(await activeTabType(page)).toBe('task')
  await page.evaluate(() =>
    window.getTrpcVanillaClient().menu.testEmit.mutate({ event: 'close-current-focus' })
  )
}

async function menuItem(page: Page, tabId: string, item: string): Promise<void> {
  await tab(page, tabId).click({ button: 'right' })
  await page.getByRole('menuitem', { name: item, exact: true }).click()
}

test.describe('Layout tab close and menu', () => {
  let projectId = ''
  let n = 0

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const p = await seed(mainWindow).createProject({
      name: 'Tabs Close',
      color: '#f97316',
      path: TEST_PROJECT_PATH
    })
    projectId = p.id
  })

  const open = (page: Page) =>
    openTaskWithLayout(page, projectId, `Close ${++n}`, START, ['terminal', 'editor'])

  test('× hides a primary panel in place; showing it again restores the tab', async ({
    mainWindow: page
  }) => {
    const taskId = await open(page)
    await tab(page, 'settings').hover()
    await tab(page, 'settings').getByRole('button', { name: 'Close Settings' }).click()
    await expect.poll(() => stripTabs(page, 's-group')).toEqual(['editor', 'diff'])
    await expect
      .poll(async () => {
        const l = await storedLayout(page, taskId)
        return l?.columns[1].slots[0].tabs.find((t) => t.instanceId === 'settings')
      })
      .toEqual({ instanceId: 'settings', hidden: true })
    // Still in the layout (a primary instance is hidden, not removed).
    expect(shapeOf(await storedLayout(page, taskId))).toEqual([
      [['terminal']],
      [['editor', 'settings', 'diff']]
    ])
  })

  test('⌘W closes the focused panel tab, then the next', async ({ mainWindow: page }) => {
    await open(page)
    await tab(page, 'diff').click()
    await expect(tab(page, 'diff')).toHaveAttribute('aria-selected', 'true')
    await emitCloseCurrentFocus(page)
    await expect.poll(() => stripTabs(page, 's-group')).toEqual(['editor', 'settings'])
    // The neighbour shows; the task tab stays open.
    await expect(tab(page, 'settings')).toHaveAttribute('aria-selected', 'true')
    expect(await activeTabType(page)).toBe('task')

    await tab(page, 'settings').click()
    await emitCloseCurrentFocus(page)
    // One tab left: no strip, the editor shows bare in its column.
    await expect(strip(page).locator('[data-tabstrip="s-group"]')).toHaveCount(0)
    await expect(panel(page, 'editor')).toBeVisible()
    expect(await activeTabType(page)).toBe('task')
  })

  test('the tab menu closes and hides', async ({ mainWindow: page }) => {
    await open(page)
    await menuItem(page, 'editor', 'Close')
    await expect.poll(() => stripTabs(page, 's-group')).toEqual(['settings', 'diff'])
    await menuItem(page, 'diff', 'Hide')
    await expect(strip(page).locator('[data-tabstrip="s-group"]')).toHaveCount(0)
    await expect(panel(page, 'settings')).toBeVisible()
  })

  test('Split down and Split right move the tab out of its group', async ({ mainWindow: page }) => {
    const taskId = await open(page)
    await menuItem(page, 'diff', 'Split down')
    await expect
      .poll(async () => shapeOf(await storedLayout(page, taskId)))
      .toEqual([[['terminal']], [['editor', 'settings'], ['diff']]])
    await menuItem(page, 'settings', 'Split right')
    await expect
      .poll(async () => shapeOf(await storedLayout(page, taskId)))
      .toEqual([[['terminal']], [['editor'], ['diff']], [['settings']]])
    await settled(page)
    const d = await panel(page, 'diff').boundingBox()
    const e = await panel(page, 'editor').boundingBox()
    expect(d && e && d.y > e.y + e.height - 1).toBe(true)
  })

  test('Rename names the tab', async ({ mainWindow: page }) => {
    const taskId = await open(page)
    await menuItem(page, 'settings', 'Rename')
    const input = tab(page, 'settings').getByRole('textbox', { name: 'Tab name' })
    await expect(input).toBeFocused()
    await input.fill('Task info')
    await input.press('Enter')
    await expect(tab(page, 'settings')).toContainText('Task info')
    await expect
      .poll(async () => {
        const l = (await storedLayout(page, taskId)) as {
          instances: Record<string, { name?: string }>
        } | null
        return l?.instances.settings?.name
      })
      .toBe('Task info')
  })
})
