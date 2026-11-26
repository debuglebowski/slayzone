import type { Locator, Page } from '@playwright/test'
import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  box,
  dragTo,
  layoutOf,
  openTaskWithLayout,
  panel,
  shapeOf,
  storedLayout,
  tab
} from '../fixtures/task-layout'

// The layout editor (docs/plans/panel-model.md step 11): a layout is built by
// dragging panel types onto it with the task view's drop zones (an edge opens a
// column, the middle adds a tab), saved as a layout of the user's, and applied to
// a task from the Layout menu.

const CLASSIC = layoutOf([
  { id: 'terminal', slots: [{ id: 'terminal', tabs: ['terminal'] }] },
  { id: 'settings', slots: [{ id: 'settings', tabs: ['settings'] }] }
])

interface StoredSetting {
  user: {
    id: string
    name: string
    columns: { slots: { tabs: { instanceId: string }[] }[] }[]
    instances: Record<string, { kind: string }>
  }[]
}

async function setting(page: Page): Promise<StoredSetting | null> {
  const raw = (await seed(page).getSetting('task_layouts')) as string | null
  return raw ? (JSON.parse(raw) as StoredSetting) : null
}

const editor = (page: Page): Locator => page.getByTestId('layout-editor')
const editorSlots = (page: Page): Locator => editor(page).getByTestId('layout-editor-slot')

test.describe('Layout editor', () => {
  let projectId = ''

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    await seed(mainWindow).setSetting('task_layouts', '')
    const p = await seed(mainWindow).createProject({
      name: 'Layout editor',
      color: '#f43f5e',
      path: TEST_PROJECT_PATH
    })
    projectId = p.id
  })

  test('builds a layout by dragging panel types, saves it and applies it', async ({
    mainWindow: page
  }) => {
    // Many pointer steps in two stacked dialogs: slow under a throttled xvfb window.
    test.setTimeout(90_000)
    const taskId = await openTaskWithLayout(page, projectId, 'Editor 1', CLASSIC, [
      'terminal',
      'settings'
    ])

    await page.locator('[data-testid="layout-menu"]:visible').click()
    await page.getByTestId('layout-manage').click()
    const manage = page.getByTestId('manage-layouts-dialog')

    await manage.getByTestId('layouts-new').click()
    await expect(editor(page)).toBeVisible()
    // A new layout starts with the agent.
    await expect(editorSlots(page)).toHaveCount(1)

    // Browser onto the agent's right edge: a column of its own.
    await dragTo(
      page,
      editor(page).getByTestId('layout-editor-palette-browser'),
      editorSlots(page).first(),
      0.95,
      0.5
    )
    await expect(editorSlots(page)).toHaveCount(2)
    const [agentSlot, browserSlot] = await Promise.all([
      box(editorSlots(page).nth(0)),
      box(editorSlots(page).nth(1))
    ])
    expect(agentSlot.x).toBeLessThan(browserSlot.x)

    // Git into the browser group's middle: a tab beside the browser.
    await dragTo(
      page,
      editor(page).getByTestId('layout-editor-palette-git'),
      editorSlots(page).nth(1),
      0.5,
      0.5
    )
    await expect(editorSlots(page)).toHaveCount(2)
    await expect(editorSlots(page).nth(1).locator('[data-kind="git"]')).toBeVisible()

    await editor(page).getByTestId('layout-editor-name').fill('Built by drag')
    await editor(page).getByTestId('layout-editor-save').click()
    await expect(editor(page)).toBeHidden()
    await expect
      .poll(async () => (await setting(page))?.user.map((u) => u.name))
      .toEqual(['Built by drag'])
    const built = (await setting(page))?.user[0]
    if (!built) throw new Error('no layout saved')
    expect(
      built.columns.map((c) =>
        c.slots.map((s) => s.tabs.map((t) => built.instances[t.instanceId].kind))
      )
    ).toEqual([[['agent']], [['browser', 'git']]])
    await expect(manage.getByTestId(`layout-row-${built.id}`)).toBeVisible()
    await manage.getByRole('button', { name: 'Done' }).click()

    // Apply it to the task.
    await page.locator('[data-testid="layout-menu"]:visible').click()
    await page.getByTestId(`layout-option-${built.id}`).click()
    await expect.poll(async () => (await storedLayout(page, taskId))?.layoutId).toBe(built.id)
    // Git was dropped into the browser's group last: its tab is the one shown.
    await expect(panel(page, 'diff')).toBeVisible()
    await expect(tab(page, 'browser')).toBeVisible()
    await expect(panel(page, 'settings')).toBeHidden()
    expect(shapeOf(await storedLayout(page, taskId))).toEqual([
      [['terminal']],
      [['browser', 'diff']]
    ])
    const [agent, git] = await Promise.all([box(panel(page, 'terminal')), box(panel(page, 'diff'))])
    expect(agent.x).toBeLessThan(git.x)
    await expect(page.locator('[data-testid="layout-menu"]:visible')).not.toHaveAttribute(
      'data-layout-dirty',
      'true'
    )
  })
})
