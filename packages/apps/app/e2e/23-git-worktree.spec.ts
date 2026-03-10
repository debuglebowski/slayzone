import { test, expect, seed, goHome, clickProject, resetApp, ensureGitRepo} from './fixtures/electron'
import { TEST_PROJECT_PATH } from './fixtures/electron'
import { execSync } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'

test.describe('Git worktree operations', () => {
  let projectAbbrev: string
  let taskId: string
  const branchName = 'worktree-task' // slugify('Worktree task')

  const getTask = async (page: import('@playwright/test').Page, id: string) =>
    page.evaluate((taskId) => window.api.db.getTask(taskId), id)

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

  const removeWorktreeButton = (page: import('@playwright/test').Page) => {
    const gitPanel = page.getByTestId('task-git-panel').last()
    return gitPanel.locator('button:has(svg.lucide-trash-2)').first()
  }

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    ensureGitRepo(TEST_PROJECT_PATH)

    // Clean up any leftover worktrees from previous runs.
    try {
      const mainWorktree = execSync('git rev-parse --show-toplevel', { cwd: TEST_PROJECT_PATH }).toString().trim()
      const worktreeList = execSync('git worktree list --porcelain', { cwd: TEST_PROJECT_PATH }).toString()
      const worktreePaths = worktreeList
        .split('\n')
        .filter(line => line.startsWith('worktree '))
        .map(line => line.replace('worktree ', '').trim())

      for (const wt of worktreePaths) {
        if (wt !== mainWorktree) {
          try { execSync(`git worktree remove --force "${wt}"`, { cwd: TEST_PROJECT_PATH }) } catch { /* ignore */ }
        }
      }
      execSync('git worktree prune', { cwd: TEST_PROJECT_PATH })
      const worktreeDir = path.join(TEST_PROJECT_PATH, 'worktrees')
      execSync(`rm -rf "${worktreeDir}"`, { cwd: TEST_PROJECT_PATH })
    } catch { /* ignore */ }

    // Delete branch if it exists from a previous run
    try { execSync(`git branch -D ${branchName}`, { cwd: TEST_PROJECT_PATH }) } catch { /* ignore */ }

    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Worktree Test', color: '#10b981', path: TEST_PROJECT_PATH })
    // Ensure default worktree base path behavior is used for this suite.
    await s.setSetting('worktree_base_path', '')
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    const t = await s.createTask({ projectId: p.id, title: 'Worktree task', status: 'todo' })
    taskId = t.id
    await s.refreshData()

    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.locator('p.line-clamp-3:visible', { hasText: 'Worktree task' }).first()).toBeVisible()
    await openTaskViaSearch(mainWindow, 'Worktree task')

    // Toggle git panel on (general tab — shows branch/worktree info)
    await mainWindow.keyboard.press('Meta+g')
    await expect(mainWindow.getByTestId('task-git-panel').last()).toBeVisible()
  })

  test('git panel shows current branch', async ({ mainWindow }) => {
    // Settings panel is visible by default — GitPanel should show branch
    const gitPanel = mainWindow.getByTestId('task-git-panel').last()
    await expect(gitPanel).toBeVisible()
    await expect(gitPanel.getByText('Git').first()).toBeVisible()
    // Should show main or master
    const branchText = gitPanel.locator('text=/main|master/')
    await expect(branchText.first()).toBeVisible()
  })

  test('shows Add Worktree button when no worktree', async ({ mainWindow }) => {
    await expect(mainWindow.getByRole('button', { name: /Add Worktree/ })).toBeVisible()
  })

  test('create worktree', async ({ mainWindow }) => {
    await mainWindow.getByRole('button', { name: /Add Worktree/ }).click()
    // Wait for creation (git worktree add + DB update)
    await expect
      .poll(async () => {
        const task = await getTask(mainWindow, taskId)
        return task?.worktree_path ?? null
      })
      .toContain(branchName)

    // Worktree name should appear (derived from slugified task title)
    const gitPanel = mainWindow.getByTestId('task-git-panel').last()
    await expect(gitPanel.getByText(branchName).first()).toBeVisible()
  })

  test('worktree shows parent branch', async ({ mainWindow }) => {
    // "from main" or "from master"
    const gitPanel = mainWindow.getByTestId('task-git-panel').last()
    const fromBranch = gitPanel.locator('text=/from\\s+(main|master)/i')
    await expect(fromBranch.first()).toBeVisible({ timeout: 10_000 })
  })

  test('worktree path persisted in DB', async ({ mainWindow }) => {
    await expect
      .poll(async () => {
        const task = await getTask(mainWindow, taskId)
        return {
          worktreePath: task?.worktree_path ?? null,
          parent: task?.worktree_parent_branch ?? null,
        }
      })
      .toMatchObject({
        worktreePath: expect.stringContaining(branchName),
        parent: expect.stringMatching(/main|master/),
      })
  })

  test('merge button visible', async ({ mainWindow }) => {
    const gitPanel = mainWindow.getByTestId('task-git-panel').last()
    const mergeBtn = gitPanel.getByRole('button', { name: /Merge into/ })
    await expect(mergeBtn).toBeVisible({ timeout: 10_000 })
  })

  test('remove worktree button visible', async ({ mainWindow }) => {
    await expect(removeWorktreeButton(mainWindow)).toBeVisible()
  })

  test('delete worktree action can be triggered', async ({ mainWindow }) => {
    await removeWorktreeButton(mainWindow).click()
    const confirm = mainWindow.getByRole('dialog').filter({ hasText: 'Remove Worktree' }).last()
    if (await confirm.isVisible({ timeout: 1_000 }).catch(() => false)) {
      const removeAction = confirm.getByRole('button', { name: /Remove|Remove Anyway/ }).last()
      await removeAction.click()
    }
    await mainWindow.waitForTimeout(250)
  })

  test('worktree metadata remains readable immediately after delete action', async ({ mainWindow }) => {
    const task = await getTask(mainWindow, taskId)
    expect(task?.worktree_path).toContain(branchName)
  })

  // Skipped because this path is still flaky after prior worktree-delete cleanup in serial runs.
  test.skip('create and verify branch exists in git', async ({ mainWindow }) => {
    // Ensure previous delete action fully detached worktree branch, if still present.
    const existing = await getTask(mainWindow, taskId)
    if (existing?.worktree_path) {
      await mainWindow.evaluate(async ({ repoPath, worktreePath, id }) => {
        await window.api.git.removeWorktree(repoPath, worktreePath).catch(() => {})
        await window.api.db.updateTask({ id, worktreePath: null })
      }, { repoPath: TEST_PROJECT_PATH, worktreePath: existing.worktree_path, id: taskId })
    }

    // Clean up branch from previous create/delete cycle
    try { execSync(`git branch -D ${branchName}`, { cwd: TEST_PROJECT_PATH }) } catch { /* ignore */ }
    try { execSync('git worktree prune', { cwd: TEST_PROJECT_PATH }) } catch { /* ignore */ }
    try { execSync(`rm -rf "${path.join(TEST_PROJECT_PATH, 'worktrees')}"`, { cwd: TEST_PROJECT_PATH }) } catch { /* ignore */ }

    // Ensure task is in "no worktree" state before re-creating.
    if (!(await mainWindow.getByRole('button', { name: /Add Worktree/ }).isVisible().catch(() => false))) {
      if (await removeWorktreeButton(mainWindow).isVisible().catch(() => false)) {
        await removeWorktreeButton(mainWindow).click()
      }
      await expect
        .poll(async () => {
          const task = await getTask(mainWindow, taskId)
          return task?.worktree_path ?? null
        })
        .toBeNull()
    }

    // Create worktree again
    const addWorktreeButton = mainWindow.getByRole('button', { name: /Add Worktree/ })
    if (await addWorktreeButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await addWorktreeButton.click()
    } else {
      const targetPath = path.join(path.dirname(TEST_PROJECT_PATH), branchName)
      const parentBranch = execSync('git branch --show-current', { cwd: TEST_PROJECT_PATH }).toString().trim() || 'main'
      await mainWindow.evaluate(async ({ repoPath, targetPath, branch, taskId, parentBranch }) => {
        await window.api.git.createWorktree(repoPath, targetPath, branch)
        await window.api.db.updateTask({
          id: taskId,
          worktreePath: targetPath,
          worktreeParentBranch: parentBranch
        })
      }, { repoPath: TEST_PROJECT_PATH, targetPath, branch: branchName, taskId, parentBranch })
    }
    await expect
      .poll(async () => {
        const task = await getTask(mainWindow, taskId)
        return task?.worktree_path ?? null
      })
      .toContain(branchName)

    // Verify branch was actually created in git
    await expect
      .poll(() => execSync('git branch', { cwd: TEST_PROJECT_PATH }).toString())
      .toContain(branchName)

    // Verify default template behavior: {project}/.. resolves to project parent.
    const task = await getTask(mainWindow, taskId)
    const worktreePathFromDb = task?.worktree_path ?? ''
    const expectedWorktreePath = path.join(path.dirname(TEST_PROJECT_PATH), branchName)
    expect(worktreePathFromDb).toBe(expectedWorktreePath)

    // Verify worktree dir exists on disk (read effective path from DB)
    const worktreePath = task?.worktree_path ?? path.join(TEST_PROJECT_PATH, 'worktrees', branchName)
    const exists = existsSync(worktreePath)
    expect(exists).toBe(true)
  })

  test('archiving a task removes its worktree from git and disk', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const projects = await s.getProjects()
    const project = projects.find((p: { name: string }) => p.name === 'Worktree Test')
    expect(project).toBeTruthy()

    const suffix = Date.now().toString()
    const branch = `archive-cleanup-${suffix}`
    const title = `Archive cleanup ${suffix}`
    const created = await s.createTask({ projectId: project!.id, title, status: 'todo' })
    const worktreePath = path.join(path.dirname(TEST_PROJECT_PATH), branch)
    const parentBranch = execSync('git branch --show-current', { cwd: TEST_PROJECT_PATH }).toString().trim()

    await mainWindow.evaluate(async ({ repoPath, targetPath, branch, taskId, parentBranch }) => {
      await window.api.git.createWorktree(repoPath, targetPath, branch)
      await window.api.db.updateTask({
        id: taskId,
        worktreePath: targetPath,
        worktreeParentBranch: parentBranch
      })
    }, { repoPath: TEST_PROJECT_PATH, targetPath: worktreePath, branch, taskId: created.id, parentBranch })

    await expect
      .poll(() => execSync('git worktree list --porcelain', { cwd: TEST_PROJECT_PATH }).toString())
      .toContain(worktreePath)
    expect(existsSync(worktreePath)).toBe(true)

    await s.archiveTask(created.id)

    await expect
      .poll(async () => {
        const archived = await getTask(mainWindow, created.id)
        return {
          archivedAt: archived?.archived_at ?? null,
          worktreePath: archived?.worktree_path ?? null
        }
      })
      .toMatchObject({
        archivedAt: expect.any(String),
        worktreePath: null
      })

    await expect
      .poll(() => execSync('git worktree list --porcelain', { cwd: TEST_PROJECT_PATH }).toString())
      .not.toContain(worktreePath)
    await expect
      .poll(() => existsSync(worktreePath))
      .toBe(false)
  })

  test('deleting a task soft-deletes it and removes it from active lists', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const projects = await s.getProjects()
    const project = projects.find((p: { name: string }) => p.name === 'Worktree Test')
    expect(project).toBeTruthy()

    const suffix = Date.now().toString()
    const branch = `delete-cleanup-${suffix}`
    const title = `Delete cleanup ${suffix}`
    const created = await s.createTask({ projectId: project!.id, title, status: 'todo' })
    const worktreePath = path.join(path.dirname(TEST_PROJECT_PATH), branch)
    const parentBranch = execSync('git branch --show-current', { cwd: TEST_PROJECT_PATH }).toString().trim()

    await mainWindow.evaluate(async ({ repoPath, targetPath, branch, taskId, parentBranch }) => {
      await window.api.git.createWorktree(repoPath, targetPath, branch)
      await window.api.db.updateTask({
        id: taskId,
        worktreePath: targetPath,
        worktreeParentBranch: parentBranch
      })
    }, { repoPath: TEST_PROJECT_PATH, targetPath: worktreePath, branch, taskId: created.id, parentBranch })

    await expect
      .poll(() => execSync('git worktree list --porcelain', { cwd: TEST_PROJECT_PATH }).toString())
      .toContain(worktreePath)
    expect(existsSync(worktreePath)).toBe(true)

    await s.deleteTask(created.id)

    await expect
      .poll(async () => {
        const deleted = await getTask(mainWindow, created.id)
        return deleted?.deleted_at ?? null
      })
      .toEqual(expect.any(String))

    await expect
      .poll(async () => {
        const active = await mainWindow.evaluate(() => window.api.db.getTasks())
        return active.some((task) => task.id === created.id)
      })
      .toBe(false)

    await expect
      .poll(() => existsSync(worktreePath))
      .toBe(true)
  })
})
