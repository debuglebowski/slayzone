/**
 * Review 2, B1: the git panel's Worktrees tab reaches every worktree of its project.
 * Its calls are scoped (§9 Phase 7b): a project's panel runs in the project's path
 * scope, a task's panel runs the tab `projectWide` — the task's project's scope, on
 * the task's computer. The project scope covers the default `../<repo>-workspaces`
 * base and every task worktree the computer holds for the project, so the per-worktree
 * dirty poll and "Delete worktree" on a sibling or orphan worktree work again; before,
 * both were refused ("…is outside the folders of project <uuid>; refused").
 *
 * Drives the real hub → local computer path through the same `worktrees.*` procedures
 * the tab calls, then the tab itself on the Home git panel.
 */
import { execSync } from 'child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import path from 'path'
import {
  test,
  expect,
  seed,
  resetApp,
  createIsolatedGitRepo,
  goHome,
  clickProject
} from '../fixtures/electron'

let gitDir: string
let workspaces: string
let siblingWt: string
let orphanWt: string

function git(cmd: string, cwd = gitDir) {
  return execSync(cmd.replace(/^git /, 'git -c commit.gpgsign=false '), {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe'
  })
}

function addWorktree(dir: string, branch: string) {
  try {
    git(`git worktree remove --force "${dir}"`)
  } catch {
    /* none yet */
  }
  try {
    git(`git branch -D ${branch}`)
  } catch {
    /* none yet */
  }
  git(`git worktree add -b ${branch} "${dir}"`)
}

type Target = { taskId?: string; projectId?: string; projectWide?: boolean }

test.describe('Worktrees tab reaches every worktree of its project (B1)', () => {
  let projectId: string
  let projectAbbrev: string
  let taskA: string
  let taskB: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    gitDir = createIsolatedGitRepo('b1-worktrees-tab')
    // The default base: a SIBLING of the project folder, outside it.
    workspaces = path.join(path.dirname(gitDir), `${path.basename(gitDir)}-workspaces`)
    rmSync(workspaces, { recursive: true, force: true })
    try {
      git('git worktree prune')
    } catch {
      /* ignore */
    }
    writeFileSync(path.join(gitDir, 'base.txt'), 'baseline\n')
    git('git add base.txt')
    try {
      git('git commit -m baseline')
    } catch {
      /* already committed */
    }
    mkdirSync(workspaces, { recursive: true })
    siblingWt = path.join(workspaces, 'b1-sibling')
    orphanWt = path.join(workspaces, 'b1-orphan')
    addWorktree(siblingWt, 'b1-sibling')
    addWorktree(orphanWt, 'b1-orphan')
    const ownWt = path.join(workspaces, 'b1-own')
    addWorktree(ownWt, 'b1-own')

    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'B1 Worktrees', color: '#22c55e', path: gitDir })
    projectId = p.id
    projectAbbrev = 'B1'
    taskA = (await s.createTask({ projectId, title: 'B1 own task', status: 'in_progress' })).id
    taskB = (await s.createTask({ projectId, title: 'B1 sibling task', status: 'in_progress' })).id
    // Each task's worktree is recorded on the computer that holds it.
    await s.updateTask({ id: taskA, worktreePath: ownWt })
    await s.updateTask({ id: taskB, worktreePath: siblingWt })
    await s.refreshData()
  })

  test.afterAll(() => {
    for (const wt of [siblingWt, orphanWt, path.join(workspaces, 'b1-own')]) {
      try {
        git(`git worktree remove --force "${wt}"`)
      } catch {
        /* gone */
      }
    }
    rmSync(workspaces, { recursive: true, force: true })
  })

  const isDirty = (page: import('@playwright/test').Page, wt: string, target: Target) =>
    page.evaluate(
      ({ p, t }) =>
        window.getTrpcVanillaClient().worktrees.isDirty.query({ path: p, target: t as never }),
      { p: wt, t: target }
    )

  test('the project scope polls a sibling and an orphan worktree in the default base', async ({
    mainWindow
  }) => {
    writeFileSync(path.join(siblingWt, 'dirty.txt'), 'uncommitted\n')
    expect(await isDirty(mainWindow, siblingWt, { projectId })).toBe(true)
    expect(await isDirty(mainWindow, orphanWt, { projectId })).toBe(false)
  })

  test("a task's panel: the tab goes project-wide; the task scope alone still refuses a sibling", async ({
    mainWindow
  }) => {
    expect(await isDirty(mainWindow, siblingWt, { taskId: taskA, projectWide: true })).toBe(true)
    await expect(isDirty(mainWindow, siblingWt, { taskId: taskA })).rejects.toThrow(
      /another task's folder|outside the folders/
    )
  })

  test('still refused: a folder outside every root of the project', async ({ mainWindow }) => {
    const outside = path.join(path.dirname(gitDir), 'b1-not-the-project')
    mkdirSync(outside, { recursive: true })
    await expect(isDirty(mainWindow, outside, { projectId })).rejects.toThrow(/refused/)
  })

  test('Home git panel → Worktrees: the dirty dot shows and an orphan worktree is deleted', async ({
    mainWindow
  }) => {
    // The dirty poll rotates through one background worktree every 10s:
    // a full sweep can extend past the default test timeout.
    test.setTimeout(150_000)
    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    // The Home view's git panel (project scope): its toggle beside "Kanban".
    const worktreesTabVisible = () =>
      mainWindow
        .getByRole('button', { name: /^Worktrees$/ })
        .first()
        .isVisible()
        .catch(() => false)
    if (!(await worktreesTabVisible())) {
      await mainWindow
        .locator('.bg-surface-2.rounded-lg')
        .filter({ has: mainWindow.locator('button:has-text("Kanban")') })
        .locator('button:has-text("Git")')
        .first()
        .click()
    }
    const worktreesTab = mainWindow.getByRole('button', { name: /^Worktrees$/ }).first()
    await expect(worktreesTab).toBeVisible({ timeout: 15_000 })
    await worktreesTab.click()

    // The sibling (dirty) worktree's card shows the "Uncommitted changes" dot. The
    // poll checks one background worktree per tick: allow a full sweep.
    const siblingCard = mainWindow
      // The card's body (`p-3`): it holds the folder icon's dirty dot and the actions
      // menu; the innermost div with the path holds neither.
      .locator('div.p-3')
      .filter({ has: mainWindow.getByText(siblingWt, { exact: true }) })
    await expect(siblingCard).toBeVisible({ timeout: 15_000 })
    await expect(siblingCard.locator('[title="Uncommitted changes"]')).toHaveCount(1, {
      timeout: 90_000
    })

    // Delete the orphan worktree from the tab: no "outside the folders" toast, gone on disk.
    const orphanCard = mainWindow
      // The card's body (`p-3`): it holds the folder icon's dirty dot and the actions
      // menu; the innermost div with the path holds neither.
      .locator('div.p-3')
      .filter({ has: mainWindow.getByText(orphanWt, { exact: true }) })
    await orphanCard.getByRole('button', { name: 'Worktree actions' }).first().click()
    await mainWindow.getByRole('menuitem', { name: /Remove Worktree/ }).click()
    await mainWindow.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(mainWindow.getByText('Worktree removed')).toBeVisible({ timeout: 15_000 })
    await expect(mainWindow.getByText(/outside the folders of project/)).toHaveCount(0)
    await expect.poll(() => existsSync(orphanWt), { timeout: 15_000 }).toBe(false)
  })
})
