import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type { Locator, Page } from '@playwright/test'
import {
  test,
  expect,
  seed,
  resetApp,
  TEST_PROJECT_PATH,
  cliRoot,
  cliEnv
} from '../fixtures/electron'
import { layoutOf, openTaskWithLayout, panel, storedLayout } from '../fixtures/task-layout'

// The agent can change the layout (docs/plans/panel-model.md step 13): `slay panels
// layout …` from a task terminal (an agent session) changes the open task view at
// once and offers Undo; with "Agent may change the layout" off (Manage layouts) the
// hub refuses it with `layout_locked` and nothing changes.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SLAY_JS = path.resolve(__dirname, '..', '..', '..', 'cli', 'dist', 'slay.js')

const CLASSIC = layoutOf([
  { id: 'terminal', slots: [{ id: 'terminal', tabs: ['terminal'] }] },
  { id: 'settings', slots: [{ id: 'settings', tabs: ['settings'] }] }
])

const toast = (page: Page): Locator =>
  page.locator('[data-sonner-toast]').filter({ hasText: 'Agent changed the layout' })
const dialog = (page: Page): Locator => page.getByTestId('manage-layouts-dialog')

test.describe('Agent layout changes', () => {
  test.describe.configure({ timeout: 90_000 })
  let projectId = ''
  let root = ''
  let n = 0

  test.beforeAll(async ({ electronApp, mainWindow }) => {
    if (!fs.existsSync(SLAY_JS))
      throw new Error(`CLI not built. Run: pnpm --filter @slayzone/cli build\nExpected: ${SLAY_JS}`)
    await resetApp(mainWindow)
    root = await cliRoot(electronApp)
    await seed(mainWindow).setSetting('task_layouts', '')
    await seed(mainWindow).setSetting('agent_may_change_layout', '1')
    const p = await seed(mainWindow).createProject({
      name: 'Agent layout',
      color: '#0ea5e9',
      path: TEST_PROJECT_PATH
    })
    projectId = p.id
  })

  const open = (page: Page) =>
    openTaskWithLayout(page, projectId, `Agent layout ${++n}`, CLASSIC, ['terminal', 'settings'])

  /** `slay` as the task's agent runs it: from its task terminal ($SLAYZONE_TASK_ID). */
  const slayAsAgent = (taskId: string, ...args: string[]) =>
    spawnSync('node', [SLAY_JS, ...args], {
      env: { ...cliEnv(root), SLAYZONE_TASK_ID: taskId },
      encoding: 'utf8'
    })

  test('an agent opens a panel: it shows in the open task view, and Undo takes it back', async ({
    mainWindow: page
  }) => {
    const taskId = await open(page)

    // Classic holds a hidden Processes panel (it follows Settings → Panels), so
    // opening one adds a second instance: `processes:<id>`.
    const r = slayAsAgent(taskId, 'panels', 'layout', 'open', 'processes', '--json')
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    const id = (JSON.parse(r.stdout) as { instanceId: string }).instanceId
    expect(id).toMatch(/^processes/)

    await expect(panel(page, id)).toBeVisible({ timeout: 15_000 })
    await expect(panel(page, 'terminal')).toBeVisible()
    await expect(toast(page)).toBeVisible({ timeout: 15_000 })

    await toast(page).getByRole('button', { name: 'Undo' }).click()
    await expect(panel(page, id)).toBeHidden({ timeout: 15_000 })
    await expect
      .poll(async () => Boolean((await storedLayout(page, taskId))?.instances[id]))
      .toBe(false)

    // `layout show` reads the undone layout back.
    const shown = slayAsAgent(taskId, 'panels', 'layout', 'show', '--json')
    const view = JSON.parse(shown.stdout) as { layout: { instances: Record<string, unknown> } }
    expect(view.layout.instances[id]).toBeUndefined()
  })

  test('with "Agent may change the layout" off, the change is refused and nothing moves', async ({
    mainWindow: page
  }) => {
    const taskId = await open(page)

    // Manage layouts → uncheck the setting.
    await page.locator('[data-testid="layout-menu"]:visible').click()
    await page.getByTestId('layout-manage').click()
    await expect(dialog(page)).toBeVisible()
    const box = dialog(page).getByTestId('agent-may-change-layout').getByRole('checkbox')
    await expect(box).toBeChecked()
    await box.click()
    await expect(box).not.toBeChecked()
    await expect.poll(() => seed(page).getSetting('agent_may_change_layout')).toBe('0')
    await dialog(page).getByRole('button', { name: 'Done' }).click()
    await expect(dialog(page)).toBeHidden()

    const r = slayAsAgent(taskId, 'panels', 'layout', 'open', 'processes')
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/does not let agents change the task layout/)

    const hide = slayAsAgent(taskId, 'panels', 'layout', 'hide', 'settings')
    expect(hide.status).toBe(1)

    // Give a change time to arrive if one had gone through: nothing did.
    await page.waitForTimeout(1_500)
    await expect(panel(page, 'processes')).toBeHidden()
    await expect(panel(page, 'settings')).toBeVisible()
    await expect(toast(page)).toHaveCount(0)
    expect(Object.keys((await storedLayout(page, taskId))?.instances ?? {}).sort()).toEqual([
      'settings',
      'terminal'
    ])

    await seed(page).setSetting('agent_may_change_layout', '1')
  })
})
