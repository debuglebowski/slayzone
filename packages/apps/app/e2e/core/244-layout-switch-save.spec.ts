import type { Locator, Page } from '@playwright/test'
import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import { focusForAppShortcut } from '../fixtures/browser-view'
import { layoutOf, openTaskWithLayout, panel, storedLayout, strip } from '../fixtures/task-layout'

// Layout definitions (docs/plans/panel-model.md step 10): the Layout menu switches
// a task between layouts without losing live state (a terminal with a session is
// parked, and comes back from ⋯ → Parked), saves the task's layout as a new layout
// or over its own, reverts to it, and ⌃⌥N switches to the N-th enabled layout.

const CLASSIC = layoutOf([
  { id: 'terminal', slots: [{ id: 'terminal', tabs: ['terminal'] }] },
  { id: 'settings', slots: [{ id: 'settings', tabs: ['settings'] }] }
])

interface StoredTab {
  instanceId: string
  hidden?: boolean
  parked?: boolean
}
interface StoredLayout {
  layoutId: string
  columns: { slots: { id: string; hidden?: boolean; tabs: StoredTab[] }[] }[]
  instances: Record<string, { id: string; kind: string; settings: Record<string, unknown> }>
}
interface StoredSetting {
  user: (StoredLayout & { id: string; name: string })[]
  order: string[]
}

const layoutButton = (page: Page): Locator => page.locator('[data-testid="layout-menu"]:visible')
const layoutMenu = (page: Page): Locator => page.getByTestId('layout-menu-content')
const newPanelButton = (page: Page): Locator =>
  page.locator('[data-testid="new-panel-menu"]:visible')

async function stored(page: Page, taskId: string): Promise<StoredLayout> {
  return (await storedLayout(page, taskId)) as unknown as StoredLayout
}

function tabOf(layout: StoredLayout, instanceId: string): StoredTab | undefined {
  for (const c of layout.columns)
    for (const s of c.slots) {
      const t = s.tabs.find((x) => x.instanceId === instanceId)
      if (t) return t
    }
  return undefined
}

async function setting(page: Page): Promise<StoredSetting | null> {
  const raw = (await seed(page).getSetting('task_layouts')) as string | null
  return raw ? (JSON.parse(raw) as StoredSetting) : null
}

async function chooseLayout(page: Page, id: string): Promise<void> {
  await layoutButton(page).click()
  await layoutMenu(page).getByTestId(`layout-option-${id}`).click()
  await expect(layoutMenu(page)).toBeHidden()
}

async function addPanel(page: Page, name: RegExp): Promise<void> {
  await newPanelButton(page).click()
  await page.getByTestId('new-panel-menu-content').getByRole('menuitem', { name }).click()
}

test.describe('Layout definitions: switch, save, revert', () => {
  let projectId = ''
  let n = 0

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    await seed(mainWindow).setSetting('task_layouts', '')
    const p = await seed(mainWindow).createProject({
      name: 'Layouts',
      color: '#22c55e',
      path: TEST_PROJECT_PATH
    })
    projectId = p.id
  })

  const open = (page: Page) =>
    openTaskWithLayout(page, projectId, `Layouts ${++n}`, CLASSIC, ['terminal', 'settings'])

  test('switching parks a live terminal panel; ⋯ → Parked brings it back', async ({
    mainWindow: page
  }) => {
    const taskId = await open(page)
    await addPanel(page, /^Terminal/)
    // The new terminal panel claims a real terminal group (a terminal_tabs row).
    await expect
      .poll(async () => {
        const l = await stored(page, taskId)
        return Object.values(l?.instances ?? {}).find((i) => i.kind === 'terminal')?.settings
          .terminalGroupIds
      })
      .toHaveLength(1)
    const before = await stored(page, taskId)
    const term = Object.values(before.instances).find((i) => i.kind === 'terminal')
    if (!term) throw new Error('no terminal panel')
    const groupId = (term.settings.terminalGroupIds as string[])[0]
    await expect(panel(page, term.id).locator('.xterm')).toBeVisible({ timeout: 15_000 })

    await chooseLayout(page, 'focus')
    await expect.poll(async () => (await stored(page, taskId)).layoutId).toBe('focus')
    await expect(panel(page, term.id)).toBeHidden()
    await expect(panel(page, 'settings')).toBeHidden()
    await expect(panel(page, 'terminal')).toBeVisible()
    const parked = await stored(page, taskId)
    expect(tabOf(parked, term.id)).toMatchObject({ hidden: true, parked: true })
    expect(parked.instances[term.id].settings.terminalGroupIds).toEqual([groupId])
    // Its terminal group lives on.
    const groups = (await page.evaluate(
      (id) => window.getTrpcVanillaClient().taskTerminals.list.query({ taskId: id }),
      taskId
    )) as { groupId: string }[]
    expect(groups.some((g) => g.groupId === groupId)).toBe(true)
    // A parked panel gets no group toggle.
    await expect(
      page.locator('[data-testid="panel-toggles"]:visible [data-panel-toggle]')
    ).toHaveCount(1)

    await newPanelButton(page).click()
    const parkedItem = page.getByTestId(`parked-panel-${term.id}`)
    await expect(page.getByTestId('parked-panels')).toBeVisible()
    await parkedItem.click()
    await expect(panel(page, term.id)).toBeVisible()
    await expect(panel(page, term.id).locator('.xterm')).toBeVisible({ timeout: 15_000 })
    await expect(panel(page, term.id).getByTestId('terminal-panel-empty')).toHaveCount(0)
    await expect.poll(async () => tabOf(await stored(page, taskId), term.id)?.parked).toBeFalsy()
  })

  test('Save as… makes a layout of the task’s; Revert and Save', async ({ mainWindow: page }) => {
    // Three menu round trips and a dialog: slow under a throttled xvfb window.
    test.setTimeout(90_000)
    const taskId = await open(page)
    await chooseLayout(page, 'focus')
    await expect.poll(async () => (await stored(page, taskId)).layoutId).toBe('focus')
    await layoutButton(page).click()
    await expect(layoutMenu(page).getByTestId('layout-menu-current')).toHaveText('Focus')
    await expect(layoutMenu(page).getByTestId('layout-unsaved')).toHaveCount(0)
    await page.keyboard.press('Escape')

    await addPanel(page, /^Git/)
    await expect(
      strip(page).locator('[data-panel-id^="git:"], [data-panel-id="diff"]')
    ).toBeVisible()
    await expect(layoutButton(page)).toHaveAttribute('data-layout-dirty', 'true')
    await layoutButton(page).click()
    await layoutMenu(page).getByTestId('layout-save-as').click()
    const dialog = page.getByTestId('save-layout-as-dialog')
    await dialog.getByTestId('save-layout-as-name').fill('Focus and Git')
    await dialog.getByTestId('save-layout-as-confirm').click()
    await expect(dialog).toBeHidden()

    await expect
      .poll(async () => (await setting(page))?.user.map((u) => u.name))
      .toEqual(['Focus and Git'])
    const mine = (await setting(page))?.user[0]
    if (!mine) throw new Error('no saved layout')
    expect(
      Object.values(mine.instances)
        .map((i) => i.kind)
        .sort()
    ).toEqual(['agent', 'git'])
    await expect.poll(async () => (await stored(page, taskId)).layoutId).toBe(mine.id)
    await expect(layoutButton(page)).not.toHaveAttribute('data-layout-dirty', 'true')

    // Hide the Git group: changed. Revert brings it back.
    const gitToggle = page
      .locator('[data-testid="panel-toggles"]:visible [data-panel-toggle]')
      .nth(1)
    await gitToggle.click()
    await expect(layoutButton(page)).toHaveAttribute('data-layout-dirty', 'true')
    await layoutButton(page).click()
    await layoutMenu(page).getByTestId('layout-revert').click()
    await expect(layoutButton(page)).not.toHaveAttribute('data-layout-dirty', 'true')
    await expect(gitToggle).toHaveAttribute('aria-pressed', 'true')

    // Hide it again and Save: the layout now starts with Git hidden.
    await gitToggle.click()
    await layoutButton(page).click()
    await layoutMenu(page).getByTestId('layout-save').click()
    await expect(layoutButton(page)).not.toHaveAttribute('data-layout-dirty', 'true')
    await expect
      .poll(async () => {
        const saved = (await setting(page))?.user[0]
        return saved?.columns.flatMap((c) => c.slots).some((s) => s.hidden === true)
      })
      .toBe(true)
  })

  test('⌃⌥N switches to the N-th enabled layout', async ({ mainWindow: page }) => {
    const taskId = await open(page)
    await focusForAppShortcut(page)
    await page.keyboard.press('Control+Alt+2')
    await expect.poll(async () => (await stored(page, taskId)).layoutId).toBe('focus')
    await expect(panel(page, 'settings')).toBeHidden()
    await focusForAppShortcut(page)
    await page.keyboard.press('Control+Alt+1')
    await expect.poll(async () => (await stored(page, taskId)).layoutId).toBe('classic')
    await expect(panel(page, 'settings')).toBeVisible()
  })
})
