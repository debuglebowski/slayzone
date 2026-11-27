import type { Locator, Page } from '@playwright/test'
import {
  test,
  expect,
  seed,
  resetApp,
  TEST_PROJECT_PATH,
  openSettingsRoute,
  closeSettingsView
} from '../fixtures/electron'
import { layoutOf, openTaskWithLayout } from '../fixtures/task-layout'

// Manage layouts (docs/plans/panel-model.md step 11): Built-in and Yours, enable
// switches that take a layout out of the Layout menu, bulk disable / enable /
// delete, and the way in from Settings → Panels, which says when Classic is
// customized (its order then no longer builds Classic).

const CLASSIC = layoutOf([
  { id: 'terminal', slots: [{ id: 'terminal', tabs: ['terminal'] }] },
  { id: 'settings', slots: [{ id: 'settings', tabs: ['settings'] }] }
])

const userLayout = (id: string, name: string) => ({
  id,
  name,
  builtin: false,
  enabled: true,
  columns: CLASSIC.columns,
  instances: CLASSIC.instances
})

const SEEDED = JSON.stringify({
  v: 1,
  defaultLayoutId: 'classic',
  builtinOverrides: {},
  user: [userLayout('layout:aaaa0001', 'Alpha'), userLayout('layout:aaaa0002', 'Beta')],
  order: []
})

interface StoredSetting {
  builtinOverrides: Record<string, { enabled?: boolean; columns?: unknown[] }>
  user: { id: string; name: string }[]
}

async function setting(page: Page): Promise<StoredSetting | null> {
  const raw = (await seed(page).getSetting('task_layouts')) as string | null
  return raw ? (JSON.parse(raw) as StoredSetting) : null
}

const dialog = (page: Page): Locator => page.getByTestId('manage-layouts-dialog')
const row = (page: Page, id: string): Locator => dialog(page).getByTestId(`layout-row-${id}`)

async function openManage(page: Page): Promise<void> {
  await page.locator('[data-testid="layout-menu"]:visible').click()
  await page.getByTestId('layout-manage').click()
  await expect(dialog(page)).toBeVisible()
}

async function closeManage(page: Page): Promise<void> {
  await dialog(page).getByRole('button', { name: 'Done' }).click()
  await expect(dialog(page)).toBeHidden()
}

test.describe('Manage layouts', () => {
  // Each test is many dialog round trips: slow under a throttled xvfb window.
  test.describe.configure({ timeout: 90_000 })
  let projectId = ''
  let n = 0

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    await seed(mainWindow).setSetting('task_layouts', SEEDED)
    const p = await seed(mainWindow).createProject({
      name: 'Manage layouts',
      color: '#a855f7',
      path: TEST_PROJECT_PATH
    })
    projectId = p.id
  })

  const open = (page: Page) =>
    openTaskWithLayout(page, projectId, `Manage ${++n}`, CLASSIC, ['terminal', 'settings'])

  test('a disabled layout leaves the Layout menu; enabling brings it back', async ({
    mainWindow: page
  }) => {
    await open(page)
    await openManage(page)
    await expect(row(page, 'layout:aaaa0001')).toBeVisible()
    await row(page, 'focus').getByTestId('layout-row-enabled').click()
    await expect(row(page, 'focus')).toHaveAttribute('data-enabled', 'false')
    await expect
      .poll(async () => (await setting(page))?.builtinOverrides.focus?.enabled)
      .toBe(false)
    await closeManage(page)

    await page.locator('[data-testid="layout-menu"]:visible').click()
    const menu = page.getByTestId('layout-menu-content')
    await expect(menu.getByTestId('layout-option-classic')).toBeVisible()
    await expect(menu.getByTestId('layout-option-layout:aaaa0001')).toBeVisible()
    await expect(menu.getByTestId('layout-option-focus')).toHaveCount(0)
    await page.keyboard.press('Escape')

    await openManage(page)
    await row(page, 'focus').getByTestId('layout-row-enabled').click()
    await expect(row(page, 'focus')).toHaveAttribute('data-enabled', 'true')
    await closeManage(page)
  })

  test('bulk disable, enable and delete', async ({ mainWindow: page }) => {
    await open(page)
    await openManage(page)
    for (const id of ['pair', 'review'])
      await row(page, id).getByTestId('layout-row-select').click()
    await expect(dialog(page).getByTestId('layouts-bulk')).toContainText('2 selected')
    // Built-ins cannot be deleted.
    await expect(dialog(page).getByTestId('layouts-bulk-delete')).toHaveCount(0)
    await dialog(page).getByTestId('layouts-bulk-disable').click()
    await expect(row(page, 'pair')).toHaveAttribute('data-enabled', 'false')
    await expect(row(page, 'review')).toHaveAttribute('data-enabled', 'false')
    await dialog(page).getByTestId('layouts-bulk-enable').click()
    await expect(row(page, 'pair')).toHaveAttribute('data-enabled', 'true')
    await dialog(page).getByTestId('layouts-bulk-cancel').click()

    for (const id of ['layout:aaaa0001', 'layout:aaaa0002'])
      await row(page, id).getByTestId('layout-row-select').click()
    await dialog(page).getByTestId('layouts-bulk-delete').click()
    await expect(row(page, 'layout:aaaa0001')).toHaveCount(0)
    await expect(row(page, 'layout:aaaa0002')).toHaveCount(0)
    await expect(dialog(page).getByTestId('layouts-empty')).toBeVisible()
    await expect.poll(async () => (await setting(page))?.user.length).toBe(0)

    // Rename in place.
    const name = row(page, 'pair').getByTestId('layout-row-name')
    await name.fill('Side by side')
    await name.press('Enter')
    await expect
      .poll(async () => (await setting(page))?.builtinOverrides.pair)
      .toMatchObject({
        name: 'Side by side'
      })
    await closeManage(page)
  })

  test('Settings → Panels opens Manage layouts and says when Classic is customized', async ({
    mainWindow: page
  }) => {
    await openSettingsRoute(page, 'panels')
    const card = page.getByTestId('panels-task-layouts')
    await expect(card).toBeVisible()
    await expect(card.getByTestId('panels-classic-customized')).toHaveCount(0)
    await card.getByTestId('panels-manage-layouts').click()
    await expect(dialog(page)).toBeVisible()
    await closeManage(page)
    await closeSettingsView(page)

    await seed(page).setSetting(
      'task_layouts',
      JSON.stringify({
        v: 1,
        defaultLayoutId: 'classic',
        builtinOverrides: { classic: { columns: CLASSIC.columns, instances: CLASSIC.instances } },
        user: [],
        order: []
      })
    )
    await openSettingsRoute(page, 'panels')
    await expect(page.getByTestId('panels-classic-customized')).toBeVisible()
    await closeSettingsView(page)
  })
})
