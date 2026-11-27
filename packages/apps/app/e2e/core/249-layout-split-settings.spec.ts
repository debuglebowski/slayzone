import type { Locator, Page } from '@playwright/test'
import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import { layoutOf, openTaskWithLayout, panel, storedLayout } from '../fixtures/task-layout'

// Settings split into Description / Subtasks / Details panels (docs/plans/panel-model.md
// step 12), and the built-in layouts the new kinds make available: Split settings,
// Two agents, Two Git and Debug — each renders the panels it is made of.

const CLASSIC = layoutOf([
  { id: 'terminal', slots: [{ id: 'terminal', tabs: ['terminal'] }] },
  { id: 'settings', slots: [{ id: 'settings', tabs: ['settings'] }] }
])

const layoutButton = (page: Page): Locator => page.locator('[data-testid="layout-menu"]:visible')
const layoutMenu = (page: Page): Locator => page.getByTestId('layout-menu-content')

async function chooseLayout(page: Page, id: string): Promise<void> {
  await layoutButton(page).click()
  await layoutMenu(page).getByTestId(`layout-option-${id}`).click()
  await expect(layoutMenu(page)).toBeHidden()
}

async function kinds(page: Page, taskId: string): Promise<string[]> {
  const l = await storedLayout(page, taskId)
  return Object.values(l?.instances ?? {})
    .map((i) => i.kind)
    .sort()
}

test.describe('Split settings and the new built-in layouts', () => {
  test.describe.configure({ timeout: 90_000 })
  let projectId = ''
  let n = 0

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    await seed(mainWindow).setSetting('task_layouts', '')
    const p = await seed(mainWindow).createProject({
      name: 'Split settings',
      color: '#f59e0b',
      path: TEST_PROJECT_PATH
    })
    projectId = p.id
  })

  const open = (page: Page) =>
    openTaskWithLayout(page, projectId, `Split ${++n}`, CLASSIC, ['terminal', 'settings'])

  test('Split settings: Description, Subtasks and Details as their own panels', async ({
    mainWindow: page
  }) => {
    const taskId = await open(page)
    await chooseLayout(page, 'split-settings')
    await expect
      .poll(async () => (await storedLayout(page, taskId))?.layoutId)
      .toBe('split-settings')
    const description = panel(page, 'description:00000001')
    const subtasks = panel(page, 'subtasks:00000001')
    const details = panel(page, 'details:00000001')
    await expect(description).toBeVisible()
    await expect(subtasks).toBeVisible()
    await expect(details).toBeVisible()
    await expect(panel(page, 'settings')).toBeHidden()

    // The description edits the task's description.
    const editor = description.getByTestId('task-description-panel-editor')
    await expect(editor).toBeVisible({ timeout: 15_000 })
    await editor.locator('[contenteditable="true"]').click()
    await page.keyboard.type('Written in its own panel')
    // Blur the editor (it saves on blur): click the Subtasks header.
    await subtasks.click({ position: { x: 20, y: 18 } })
    await expect
      .poll(async () => {
        const t = (await page.evaluate(
          (id) => window.getTrpcVanillaClient().task.get.query({ id }),
          taskId
        )) as { description?: string | null } | null
        return t?.description ?? ''
      })
      .toContain('Written in its own panel')

    // Subtasks adds one.
    await subtasks.getByRole('button', { name: 'Add subtask' }).click()
    await subtasks.getByPlaceholder('Sub-task title...').fill('First step')
    await subtasks.getByPlaceholder('Sub-task title...').press('Enter')
    await expect(subtasks.getByText('First step')).toBeVisible({ timeout: 15_000 })

    // Details holds the task's metadata, working directory and danger zone.
    await expect(details.getByTestId('task-details')).toBeVisible()
    await expect(details.getByRole('button', { name: 'Archive' })).toBeVisible()

    // ⋯ → Description again shows the one the task has: one per task.
    await page.locator('[data-testid="new-panel-menu"]:visible').click()
    await page.getByTestId('new-panel-description').click()
    await expect(description).toBeVisible()
    expect((await kinds(page, taskId)).filter((k) => k === 'description')).toHaveLength(1)
  })

  test('Two agents, Two Git and Debug render their panels', async ({ mainWindow: page }) => {
    const taskId = await open(page)

    await chooseLayout(page, 'two-agents')
    await expect(panel(page, 'terminal')).toBeVisible()
    await expect(panel(page, 'agent:00000002')).toBeVisible()
    // The second agent panel starts with a terminal of its own.
    await expect
      .poll(async () => {
        const l = await storedLayout(page, taskId)
        const settings = l?.instances['agent:00000002']?.settings as
          | Record<string, unknown>
          | undefined
        return (settings?.terminalGroupIds as string[] | undefined)?.length
      })
      .toBe(1)

    await chooseLayout(page, 'two-git')
    await expect(panel(page, 'diff')).toBeVisible()
    await expect(panel(page, 'git:00000002')).toBeVisible()

    await chooseLayout(page, 'debug')
    await expect(panel(page, 'terminal')).toBeVisible()
    await expect(panel(page, 'terminal:00000001')).toBeVisible()
    await expect(panel(page, 'browser')).toBeVisible()
    await expect(panel(page, 'processes')).toBeVisible()
  })
})
