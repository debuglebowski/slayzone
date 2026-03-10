import { test, expect, seed, goHome, clickProject, resetApp, ensureGitRepo} from './fixtures/electron'
import { TEST_PROJECT_PATH } from './fixtures/electron'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'

test.describe('Git branch switching & creation', () => {
  let projectAbbrev: string
  let taskId: string

  /** git command helper scoped to the test project's own repo */
  const git = (cmd: string) =>
    execSync(cmd, { cwd: TEST_PROJECT_PATH, encoding: 'utf-8' }).trim()

  const openTaskViaSearch = async (
    page: import('@playwright/test').Page,
    title: string
  ) => {
    const taskCardTitle = page.getByText(title).first()
    if (await taskCardTitle.isVisible({ timeout: 1_500 }).catch(() => false)) {
      await taskCardTitle.click()
    } else {
      await page.keyboard.press('Meta+k')
      const input = page.getByPlaceholder('Search tasks and projects...')
      await expect(input).toBeVisible()
      await input.fill(title)
      await page.getByRole('dialog').last().getByText(title).first().click()
    }
    await expect(page.locator('[data-testid="terminal-mode-trigger"]:visible').first()).toBeVisible({ timeout: 5_000 })
  }

  const panel = (page: import('@playwright/test').Page) =>
    page.getByTestId('task-git-panel').last()

  const branchTrigger = (page: import('@playwright/test').Page) =>
    panel(page).getByTestId('branch-trigger')

  const popover = (page: import('@playwright/test').Page) =>
    page.locator('[data-radix-popper-content-wrapper]').last()

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    ensureGitRepo(TEST_PROJECT_PATH)

    // Ensure we're on main/master
    const currentBranch = git('git branch --show-current')
    if (!currentBranch) {
      try { git('git checkout main') } catch {
        try { git('git checkout master') } catch { /* ignore */ }
      }
    }

    // Clean up test branches from previous runs
    for (const b of ['e2e-branch-a', 'e2e-new-branch']) {
      try { git(`git branch -D ${b}`) } catch { /* ignore */ }
    }

    // Create a branch for switching tests
    git('git branch e2e-branch-a')

    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Branch Test', color: '#6366f1', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    const t = await s.createTask({ projectId: p.id, title: 'Branch switching task', status: 'todo' })
    taskId = t.id
    await s.refreshData()

    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await openTaskViaSearch(mainWindow, 'Branch switching task')

    // Toggle git panel on (general tab — shows branch controls)
    await mainWindow.keyboard.press('Meta+g')
    await expect(panel(mainWindow)).toBeVisible()
  })

  test('branch popover opens and lists branches', async ({ mainWindow }) => {
    const p = panel(mainWindow)
    await expect(p).toBeVisible()

    const trigger = branchTrigger(mainWindow)
    await expect(trigger).toBeVisible()
    await trigger.click()

    const pop = popover(mainWindow)
    await expect(pop).toBeVisible()

    // Should contain the current branch (main or master)
    await expect(pop.locator('text=/main|master/')).toBeVisible()
    // Should contain e2e-branch-a
    await expect(pop.getByText('e2e-branch-a')).toBeVisible()
    // Should have create input
    await expect(pop.getByPlaceholder('New branch...')).toBeVisible()

    await mainWindow.keyboard.press('Escape')
    await expect(pop).not.toBeVisible()
  })

  test('create new branch from popover', async ({ mainWindow }) => {
    const trigger = branchTrigger(mainWindow)
    await trigger.click()

    const pop = popover(mainWindow)
    await expect(pop).toBeVisible()

    const input = pop.getByPlaceholder('New branch...')
    await input.fill('e2e-new-branch')
    await input.press('Enter')

    // Popover closes, branch updates in panel
    await expect(pop).not.toBeVisible({ timeout: 5000 })
    await expect(panel(mainWindow).getByText('e2e-new-branch')).toBeVisible()

    // Verify in git
    expect(git('git branch --show-current')).toBe('e2e-new-branch')
  })

  // Re-enabled: validate branch switch flow to an existing branch.
  test('switch to existing branch', async ({ mainWindow }) => {
    // Keep this case independent from prior tests in the serial full-suite run.
    try { git('git reset --hard') } catch { /* ignore */ }
    try { git('git clean -fd') } catch { /* ignore */ }

    const trigger = branchTrigger(mainWindow)
    await trigger.click()

    const pop = popover(mainWindow)
    await expect(pop).toBeVisible()

    const branchButton = pop.locator('button').filter({ hasText: /^e2e-branch-a$/ }).first()
    await expect(branchButton).toBeVisible({ timeout: 5_000 })
    await branchButton.click({ force: true })

    // In long serial runs the popover can remain open after selection;
    // assert the actual branch switch instead of popover visibility.
    await expect.poll(() => git('git branch --show-current'), { timeout: 5_000 }).toBe('e2e-branch-a')
    await expect(panel(mainWindow).getByText('e2e-branch-a')).toBeVisible()

    await mainWindow.keyboard.press('Escape').catch(() => {})
  })

  // Re-enabled: validate dirty-worktree guard when switching branches.
  test('switching with uncommitted changes is blocked', async ({ mainWindow }) => {
    // Create a tracked, staged change
    fs.writeFileSync(path.join(TEST_PROJECT_PATH, 'README.md'), '# dirty\n')
    git('git add README.md')

    const trigger = branchTrigger(mainWindow)
    await trigger.click()

    const pop = popover(mainWindow)
    await expect(pop).toBeVisible()

    const currentBranch = git('git branch --show-current')
    // Try to switch to a different branch
    const targetBranch = currentBranch === 'e2e-branch-a'
      ? (git('git branch --list main').length > 0 ? 'main' : 'master')
      : 'e2e-branch-a'
    const target = pop.locator('button').filter({ hasText: new RegExp(`^${targetBranch}$`) }).first()
    await target.click()

    // Branch should remain unchanged when staged changes exist.
    await expect.poll(() => git('git branch --show-current'), { timeout: 5_000 }).toBe(currentBranch)

    // Clean up staged change (README.md is new, not tracked — can't use checkout)
    git('git reset README.md')
    fs.unlinkSync(path.join(TEST_PROJECT_PATH, 'README.md'))
    await mainWindow.keyboard.press('Escape')
  })

  test('branch popover hidden when worktree exists', async ({ mainWindow }) => {
    // Switch back to main for worktree creation
    const current = git('git branch --show-current')
    if (current !== 'main' && current !== 'master') {
      try { git('git checkout main') } catch {
        git('git checkout master')
      }
    }

    const s = seed(mainWindow)
    const projects = await s.getProjects()
    const project = projects.find((p: { name: string }) => p.name === 'Branch Test')

    const suffix = Date.now().toString()
    const branch = `e2e-wt-${suffix}`
    const t = await s.createTask({ projectId: project!.id, title: `WTBranch ${suffix}`, status: 'todo' })
    const worktreePath = `${TEST_PROJECT_PATH}-wt-${suffix}`

    await mainWindow.evaluate(async ({ repoPath, targetPath, branch, taskId }) => {
      await window.api.git.createWorktree(repoPath, targetPath, branch)
      await window.api.db.updateTask({
        id: taskId,
        worktreePath: targetPath,
        worktreeParentBranch: 'main'
      })
    }, { repoPath: TEST_PROJECT_PATH, targetPath: worktreePath, branch, taskId: t.id })

    await s.refreshData()
    await openTaskViaSearch(mainWindow, `WTBranch ${suffix}`)

    // Toggle git panel on for the new task
    await mainWindow.keyboard.press('Meta+g')

    const p = panel(mainWindow)
    await expect(p).toBeVisible({ timeout: 10_000 })

    // No branch trigger — worktree locks branch
    await expect(branchTrigger(mainWindow)).not.toBeVisible()
    // "from main/master" text shows parent branch
    await expect(p.locator('text=/main|master/').first()).toBeVisible({ timeout: 10_000 })

    // Cleanup
    try { execSync(`git worktree remove --force "${worktreePath}"`, { cwd: TEST_PROJECT_PATH }) } catch { /* ignore */ }
    try { git(`git branch -D ${branch}`) } catch { /* ignore */ }
  })
})
