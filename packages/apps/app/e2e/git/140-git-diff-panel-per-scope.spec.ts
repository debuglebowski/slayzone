/**
 * Every git diff panel reads ITS OWN project's / task's checkout, in its own path
 * scope (§9 Phase 7b) — not the scope of whichever panel opened first.
 *
 * The diff store is shared by every git panel in the window. It used to wire its
 * transport once, from the first panel's scoped client, so every later panel's diff
 * read and fs watch went out in the FIRST panel's project. The computer refused them:
 * "path '<project B folder>' is outside the folders of project <project A>; refused"
 * (2026-11-11, Home git panel after switching project). No spec caught it: each opens
 * one diff panel per renderer load.
 */
import { writeFileSync } from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import {
  test,
  expect,
  seed,
  resetApp,
  createIsolatedGitRepo,
  openTaskById,
  goHome,
  clickProject
} from '../fixtures/electron'

const REFUSED = /outside the folders of|has no folder on this computer|refused/

/** The visible git diff panel (other tabs keep hidden ones mounted). */
const diffPanel = (page: Page) => page.locator('[data-testid="git-diff-panel"]:visible')

async function openTaskDiff(page: Page, taskId: string) {
  await openTaskById(page, taskId)
  const gitPanel = page.locator('[data-testid="task-git-panel"]:visible')
  // The panel's open state carries over between tasks: open it only when its toggle
  // says it is shut (a blind ⌘G closes a panel that was still mounting).
  const toggle = page
    .getByRole('button', { name: /^Git(?:\s|$)/ })
    .locator('visible=true')
    .first()
  await expect(toggle).toBeVisible({ timeout: 10_000 })
  // A click right after the tab opens can be undone by the task's panel layout
  // loading after it: click again until the toggle stays on AND the panel shows.
  await expect(async () => {
    if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true', { timeout: 1_000 })
    await expect(gitPanel).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 25_000 })
  await gitPanel.getByRole('button', { name: /^Diff(?:\s|$)/ }).click()
  await expect(diffPanel(page)).toBeVisible({ timeout: 5_000 })
}

test.describe('git diff panels in different scopes (one renderer load)', () => {
  let taskA: string
  let taskB: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const repoA = createIsolatedGitRepo('scope-a')
    const repoB = createIsolatedGitRepo('scope-b')
    // One untracked file per repo: each panel's diff names only its own.
    writeFileSync(path.join(repoA, 'only-in-a.txt'), 'a\n')
    writeFileSync(path.join(repoB, 'only-in-b.txt'), 'b\n')

    const s = seed(mainWindow)
    const pA = await s.createProject({ name: 'PA Scope', color: '#0ea5e9', path: repoA })
    const pB = await s.createProject({ name: 'PB Scope', color: '#f97316', path: repoB })
    taskA = (await s.createTask({ projectId: pA.id, title: 'Scope A task', status: 'todo' })).id
    taskB = (await s.createTask({ projectId: pB.id, title: 'Scope B task', status: 'todo' })).id
    await s.refreshData()
  })

  test("a second task's diff (another project) reads its own checkout", async ({ mainWindow }) => {
    await openTaskDiff(mainWindow, taskA)
    await expect(diffPanel(mainWindow).getByText('only-in-a.txt')).toBeVisible({ timeout: 10_000 })

    await openTaskDiff(mainWindow, taskB)
    await expect(diffPanel(mainWindow).getByText('only-in-b.txt')).toBeVisible({ timeout: 10_000 })
    await expect(diffPanel(mainWindow).getByText(REFUSED)).toHaveCount(0)
  })

  test('Home git panel: switching project reads the new project', async ({ mainWindow }) => {
    // The Home view's git panel (project scope), opened on its Diff tab. Its open
    // state is per project: open it again after each switch.
    const openHomeDiff = async (abbrev: string) => {
      await clickProject(mainWindow, abbrev)
      const diffTab = mainWindow.getByRole('button', { name: /^Diff(?:\s|$)/ }).first()
      const open = await diffTab
        .waitFor({ state: 'visible', timeout: 2_000 })
        .then(() => true)
        .catch(() => false)
      if (!open) {
        await mainWindow
          .locator('.bg-surface-2.rounded-lg')
          .filter({ has: mainWindow.locator('button:has-text("Kanban")') })
          .locator('button:has-text("Git")')
          .first()
          .click()
      }
      await expect(diffTab).toBeVisible({ timeout: 15_000 })
      await diffTab.click()
      await expect(diffPanel(mainWindow)).toBeVisible({ timeout: 5_000 })
    }

    await goHome(mainWindow)
    await openHomeDiff('PA')
    await expect(diffPanel(mainWindow).getByText('only-in-a.txt')).toBeVisible({ timeout: 10_000 })

    await openHomeDiff('PB')
    await expect(diffPanel(mainWindow).getByText('only-in-b.txt')).toBeVisible({ timeout: 10_000 })
    await expect(diffPanel(mainWindow).getByText(REFUSED)).toHaveCount(0)
  })
})
