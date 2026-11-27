import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect, seed, resetApp, createIsolatedGitRepo } from '../fixtures/electron'
import { focusForAppShortcut } from '../fixtures/browser-view'
import { shortcutKey } from '../fixtures/shortcuts'
import { layoutOf, openTaskWithLayout, panel, storedLayout, tab } from '../fixtures/task-layout'

// Several panels of one kind (docs/plans/panel-model.md step 7). A second Git panel
// keeps its own view: its tab lives in tasks.panel_instance_state, the primary's in
// git_active_tab. Kind-wide shortcuts act on the panel of that kind focused last,
// else the primary. "New <kind> panel" in a tab's menu adds one; closing a
// non-primary panel removes it with its state.

const SECOND = 'git:aaaa1111'

const LAYOUT = layoutOf([
  { id: 'diff', slots: [{ id: 'diff', tabs: ['diff'] }] },
  { id: 'g2', slots: [{ id: 's-g2', tabs: [SECOND, 'settings'] }] }
])

const gitTab = (page: Page, panelId: string, name: RegExp) =>
  panel(page, panelId).getByRole('button', { name })
const expectActive = async (page: Page, panelId: string, name: RegExp) =>
  expect(gitTab(page, panelId, name)).toHaveClass(/shadow-sm/, { timeout: 5_000 })

async function storedTask(page: Page, taskId: string) {
  return page.evaluate(
    async (id) => window.getTrpcVanillaClient().task.get.query({ id }),
    taskId
  ) as Promise<{
    git_active_tab?: string | null
    panel_instance_state?: Record<string, Record<string, unknown>> | null
  } | null>
}

test.describe('Layout: two Git panels', () => {
  let projectId = ''

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const repo = createIsolatedGitRepo('two-git-panels')
    fs.rmSync(repo, { recursive: true, force: true })
    const fresh = createIsolatedGitRepo('two-git-panels')
    fs.writeFileSync(path.join(fresh, 'a.txt'), 'a\n')
    execSync('git add a.txt && git -c commit.gpgsign=false commit -m a', { cwd: fresh })
    const p = await seed(mainWindow).createProject({
      name: 'Two git',
      color: '#f97316',
      path: fresh
    })
    projectId = p.id
  })

  test('each Git panel keeps its own tab; ⌘⇧G acts on the one focused last', async ({
    mainWindow: page
  }) => {
    const taskId = await openTaskWithLayout(page, projectId, 'Git 1', LAYOUT, ['diff', SECOND])
    await expectActive(page, 'diff', /^General/)
    await expectActive(page, SECOND, /^General/)

    // Switch only the second panel to Changes.
    await gitTab(page, SECOND, /^Diff/).click()
    await expectActive(page, SECOND, /^Diff/)
    await expectActive(page, 'diff', /^General/)
    await expect
      .poll(async () => (await storedTask(page, taskId))?.panel_instance_state?.[SECOND]?.gitTab)
      .toBe('changes')
    expect((await storedTask(page, taskId))?.git_active_tab ?? 'general').toBe('general')

    // ⇧⌘G (already on Changes) closes the focused panel — the second one…
    await gitTab(page, SECOND, /^Diff/).focus()
    await focusForAppShortcut(page)
    await page.keyboard.press(shortcutKey('panel-git-diff'))
    await expect(panel(page, SECOND)).toBeHidden()
    await expect(panel(page, 'diff')).toBeVisible()
    await expectActive(page, 'diff', /^General/)
  })

  test('"New Git panel" in a tab menu adds one; closing it removes it and its state', async ({
    mainWindow: page
  }) => {
    const taskId = await openTaskWithLayout(page, projectId, 'Git 2', LAYOUT, ['diff', SECOND])
    await gitTab(page, SECOND, /^Diff/).click()
    await expect
      .poll(async () => (await storedTask(page, taskId))?.panel_instance_state?.[SECOND]?.gitTab)
      .toBe('changes')

    await tab(page, SECOND).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'New Git panel' }).click()
    await expect
      .poll(async () => {
        const layout = await storedLayout(page, taskId)
        return Object.values(layout?.instances ?? {}).filter((i) => i.kind === 'git').length
      })
      .toBe(3)
    const layout = await storedLayout(page, taskId)
    const third = Object.keys(layout?.instances ?? {}).find(
      (id) => id.startsWith('git:') && id !== SECOND
    )!
    // A tab in the same group, shown, on its own default view.
    expect(layout?.columns[1].slots[0].tabs.map((t) => t.instanceId)).toContain(third)
    await expect(panel(page, third)).toBeVisible()
    await expectActive(page, third, /^General/)

    // Close the second panel: it is removed, and so is its state.
    await tab(page, SECOND).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Close' }).click()
    await expect
      .poll(async () => Object.keys((await storedLayout(page, taskId))?.instances ?? {}))
      .not.toContain(SECOND)
    await expect
      .poll(async () => Object.keys((await storedTask(page, taskId))?.panel_instance_state ?? {}))
      .not.toContain(SECOND)
  })
})
