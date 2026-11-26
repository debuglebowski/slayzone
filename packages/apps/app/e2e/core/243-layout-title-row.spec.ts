import type { Locator, Page } from '@playwright/test'
import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  box,
  layoutOf,
  openTaskWithLayout,
  panel,
  shapeOf,
  storedLayout,
  strip
} from '../fixtures/task-layout'

// The title row (docs/plans/panel-model.md step 9): one toggle per tab group that
// shows/hides the whole group in place, right-click Rename, the ⋯ New panel menu,
// and the Layout button's dropdown.

const START = layoutOf([
  { id: 'terminal', slots: [{ id: 'terminal', tabs: ['terminal'] }] },
  { id: 'mid', slots: [{ id: 's-mid', tabs: ['editor', 'diff'] }] },
  { id: 'settings', slots: [{ id: 'settings', tabs: ['settings'] }] }
])

const CLASSIC = layoutOf([
  { id: 'terminal', slots: [{ id: 'terminal', tabs: ['terminal'] }] },
  { id: 'settings', slots: [{ id: 'settings', tabs: ['settings'] }] }
])

const toggles = (page: Page): Locator => page.locator('[data-testid="panel-toggles"]:visible')
const toggle = (page: Page, slotId: string): Locator =>
  toggles(page).locator(`[data-panel-toggle="${slotId}"]`)

/** The middle group of a stored layout, as stored. */
async function midGroup(page: Page, taskId: string) {
  const l = await storedLayout(page, taskId)
  return l?.columns[1].slots[0] as { hidden?: boolean; name?: string } | undefined
}

async function toggleOrder(page: Page): Promise<string[]> {
  return toggles(page)
    .locator('[data-panel-toggle]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-panel-toggle') ?? ''))
}

test.describe('Layout title row', () => {
  let projectId = ''
  let n = 0

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const p = await seed(mainWindow).createProject({
      name: 'Title Row',
      color: '#0ea5e9',
      path: TEST_PROJECT_PATH
    })
    projectId = p.id
  })

  const open = (page: Page, layout = START, waitFor = ['terminal', 'editor', 'settings']) =>
    openTaskWithLayout(page, projectId, `Title row ${++n}`, layout, waitFor)

  test('a group toggle hides and shows its whole group in place', async ({ mainWindow: page }) => {
    const taskId = await open(page)
    expect(await toggleOrder(page)).toEqual(['terminal', 's-mid', 'settings'])
    // Named from its contents; pressed while shown.
    await expect(toggle(page, 's-mid')).toHaveAccessibleName('Editor + Git')
    await expect(toggle(page, 's-mid')).toHaveAttribute('aria-pressed', 'true')

    await toggle(page, 's-mid').click()
    await expect(toggle(page, 's-mid')).toHaveAttribute('aria-pressed', 'false')
    await expect(panel(page, 'editor')).toBeHidden()
    await expect.poll(async () => (await midGroup(page, taskId))?.hidden).toBe(true)
    // Hidden keeps position: the toggle and the group stay where they were.
    expect(await toggleOrder(page)).toEqual(['terminal', 's-mid', 'settings'])
    expect(shapeOf(await storedLayout(page, taskId))).toEqual([
      [['terminal']],
      [['editor', 'diff']],
      [['settings']]
    ])

    await toggle(page, 's-mid').click()
    await expect(toggle(page, 's-mid')).toHaveAttribute('aria-pressed', 'true')
    await expect(panel(page, 'editor')).toBeVisible()
    const [agent, editor, settings] = await Promise.all(
      ['terminal', 'editor', 'settings'].map((id) => box(panel(page, id)))
    )
    expect(agent.x).toBeLessThan(editor.x)
    expect(editor.x).toBeLessThan(settings.x)
  })

  test('right-click → Rename names the group', async ({ mainWindow: page }) => {
    const taskId = await open(page)
    await toggle(page, 's-mid').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Rename' }).click()
    const field = page.getByRole('textbox', { name: 'Group name' })
    await expect(field).toHaveAttribute('placeholder', 'Editor + Git')
    await field.fill('Review')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(toggle(page, 's-mid')).toHaveAccessibleName('Review')
    await expect.poll(async () => (await midGroup(page, taskId))?.name).toBe('Review')
  })

  test('⋯ opens the New panel menu, which adds a panel', async ({ mainWindow: page }) => {
    const taskId = await open(page)
    await page.locator('[data-testid="new-panel-menu"]:visible').click()
    const menu = page.getByTestId('new-panel-menu-content')
    await expect(menu.getByRole('group', { name: 'Run' })).toBeVisible()
    await expect(menu.getByRole('group', { name: 'Code' })).toBeVisible()
    await menu.getByRole('menuitem', { name: /^Git/ }).click()
    await expect
      .poll(async () => {
        const l = await storedLayout(page, taskId)
        return Object.values(l?.instances ?? {}).filter((i) => i.kind === 'git').length
      })
      .toBe(2)
    // The new Git panel is a group of its own, with its own toggle at the end.
    await expect.poll(() => toggleOrder(page).then((o) => o.length)).toBe(4)
    await expect(strip(page).locator('[data-panel-id^="git:"]')).toBeVisible()
  })

  test('the Layout button opens the layouts dropdown', async ({ mainWindow: page }) => {
    await open(page, CLASSIC, ['terminal', 'settings'])
    await page.locator('[data-testid="layout-menu"]:visible').click()
    const menu = page.getByTestId('layout-menu-content')
    await expect(menu.getByTestId('layout-menu-current')).toHaveText('Classic')
    await expect(menu.getByRole('menuitem', { name: 'Classic' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Focus' })).toBeVisible()
    await page.keyboard.press('Escape')

    // A layout the user has changed is Custom.
    await open(page)
    await page.locator('[data-testid="layout-menu"]:visible').click()
    await expect(
      page.getByTestId('layout-menu-content').getByTestId('layout-menu-current')
    ).toHaveText('Custom')
    await page.keyboard.press('Escape')
  })
})
