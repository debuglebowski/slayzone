import {
  test,
  expect,
  seed,
  goHome,
  clickProject,
  resetApp,
  createIsolatedGitRepo,
  openTaskById
} from '../fixtures/electron'
import { execSync } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'

test.describe('Git worktree operations', () => {
  let projectAbbrev: string
  let taskId: string
  // Isolated per-worker repo (matches 32/33/34/35). Using the shared repoDir
  // let ~180 prior specs accumulate worktrees/branches there, so the UI "Branch to
  // worktree" flow (which creates at the repo-default location) hit stale state and
  // failed deterministically in the full suite while passing in isolation.
  let repoDir: string
  const branchName = 'worktree-task' // slugify('Worktree task')

  const getTask = async (page: import('@playwright/test').Page, id: string) =>
    page.evaluate((taskId) => window.getTrpcVanillaClient().task.get.query({ id: taskId }), id)

  const execGit = (command: string) =>
    execSync(command, { cwd: repoDir, stdio: 'pipe' }).toString()

  // Open + activate the worktree task deterministically by id (shared fixture). The
  // prior card-click / search-dialog heuristic was the root of this describe's
  // flakiness: its open could leave a DIFFERENT task active (incl. a stray temporary
  // "Terminal N" scratch task), and the globally-matched "Branch to worktree" button
  // (only the active tab's panel is visible) then created the worktree on the WRONG
  // task — leaving this task's worktree_path null and losing the whole describe.
  const activateWorktreeTask = (page: import('@playwright/test').Page) =>
    openTaskById(page, taskId)

  const removeWorktreeButton = (page: import('@playwright/test').Page) => {
    const gitPanel = page.getByTestId('task-git-panel').last()
    return gitPanel.getByRole('button', { name: /Delete worktree/i }).first()
  }

  test.beforeAll(async ({ mainWindow }) => {
    // This whole describe rides on a single task-open below; default 30s hook budget
    // is too tight once activateWorktreeTask (40s) is allowed its full retry window
    // under mid-suite load. Raise it so a slow-but-successful open can't strand all
    // ~12 tests.
    test.setTimeout(90_000)
    await resetApp(mainWindow)
    repoDir = createIsolatedGitRepo('worktree')

    // Clean up any leftover worktrees from previous runs.
    try {
      const mainWorktree = execGit('git rev-parse --show-toplevel').trim()
      const worktreeList = execGit('git worktree list --porcelain')
      const worktreePaths = worktreeList
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.replace('worktree ', '').trim())

      for (const wt of worktreePaths) {
        if (wt !== mainWorktree) {
          try {
            execGit(`git worktree remove --force "${wt}"`)
          } catch {
            /* ignore */
          }
        }
      }
      execGit('git worktree prune')
      const worktreeDir = path.join(repoDir, 'worktrees')
      execSync(`rm -rf "${worktreeDir}"`, { cwd: repoDir, stdio: 'pipe' })
    } catch {
      /* ignore */
    }

    // Delete branch if it exists from a previous run
    try {
      execGit(`git branch -D ${branchName}`)
    } catch {
      /* ignore */
    }

    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Worktree Test',
      color: '#10b981',
      path: repoDir
    })
    // Ensure default worktree base path behavior is used for this suite.
    await s.setSetting('worktree_base_path', '')
    await s.setSetting('worktree_copy_behavior', 'none')
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    const t = await s.createTask({ projectId: p.id, title: 'Worktree task', status: 'todo' })
    taskId = t.id
    await s.refreshData()

    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    // Open the worktree task deterministically by id (see activateWorktreeTask).
    await activateWorktreeTask(mainWindow)

    // Toggle git panel on (general tab — shows branch/worktree info)
    await mainWindow.keyboard.press('Meta+g')
    await expect(mainWindow.getByTestId('task-git-panel').last()).toBeVisible()
  })

  test('git panel shows current branch', async ({ mainWindow }) => {
    const gitPanel = mainWindow.getByTestId('task-git-panel').last()
    await expect(gitPanel).toBeVisible()
    await expect(gitPanel.getByRole('button', { name: /General/i })).toBeVisible()
    // Should show main or master
    const branchText = gitPanel.locator('text=/main|master/')
    await expect(branchText.first()).toBeVisible()
  })

  test('shows Branch to worktree button when no worktree', async ({ mainWindow }) => {
    await expect(mainWindow.getByRole('button', { name: /Branch to worktree/ })).toBeVisible()
  })

  test('create worktree', async ({ mainWindow }) => {
    // Click ONCE then poll. Do NOT retry the click: `git worktree add` is a slow
    // async op under machine contention, and a second click mid-creation kicks off a
    // conflicting add that can leave worktree_path null. A generous poll tolerates the
    // slow op; the per-test timeout is widened to fit it.
    test.setTimeout(45_000)
    // Re-activate the worktree task right before clicking. The "Branch to worktree"
    // button is matched globally (only the ACTIVE task's git panel is visible), so if
    // anything captured the active tab during setup the click would create the worktree
    // on the wrong task and leave THIS task's worktree_path null. Opening by id is
    // deterministic and idempotent (no-op if already active).
    await activateWorktreeTask(mainWindow)
    const branchBtn = mainWindow.getByRole('button', { name: /Branch to worktree/ })
    await expect(branchBtn).toBeVisible({ timeout: 10_000 })
    await branchBtn.click()
    await expect
      .poll(
        async () => {
          const task = await getTask(mainWindow, taskId)
          return task?.worktree_path ?? null
        },
        { timeout: 30_000 }
      )
      .toContain(branchName)

    // Worktree name should appear (derived from slugified task title)
    const gitPanel = mainWindow.getByTestId('task-git-panel').last()
    await expect(gitPanel.getByText(branchName).first()).toBeVisible()
  })

  test('worktree shows parent branch', async ({ mainWindow }) => {
    const gitPanel = mainWindow.getByTestId('task-git-panel').last()
    const parentBranch = gitPanel.locator('svg.lucide-arrow-left').locator('xpath=..')
    await expect(parentBranch).toContainText(/main|master/i, { timeout: 10_000 })
  })

  test('worktree path persisted in DB', async ({ mainWindow }) => {
    await expect
      .poll(
        async () => {
          const task = await getTask(mainWindow, taskId)
          return {
            worktreePath: task?.worktree_path ?? null,
            parent: task?.worktree_parent_branch ?? null
          }
        },
        { timeout: 10_000 }
      )
      .toMatchObject({
        worktreePath: expect.stringContaining(branchName),
        parent: expect.stringMatching(/main|master/)
      })
  })

  test('merge button visible', async ({ mainWindow }) => {
    const gitPanel = mainWindow.getByTestId('task-git-panel').last()
    const mergeBtn = gitPanel.getByRole('button', { name: /Merge to (main|master)/i })
    await expect(mergeBtn).toBeVisible({ timeout: 10_000 })
  })

  test('remove worktree button visible', async ({ mainWindow }) => {
    await expect(removeWorktreeButton(mainWindow)).toBeVisible()
  })

  test('delete worktree action can be triggered', async ({ mainWindow }) => {
    await removeWorktreeButton(mainWindow).click()
    const confirm = mainWindow.getByRole('dialog').filter({ hasText: 'Delete worktree' }).last()
    if (await confirm.isVisible({ timeout: 1_000 }).catch(() => false)) {
      const removeAction = confirm.getByRole('button', { name: /^Delete worktree$/ }).last()
      await removeAction.click()
    }
    await mainWindow.waitForTimeout(250)
  })

  test('worktree metadata remains readable immediately after delete action', async ({
    mainWindow
  }) => {
    const task = await getTask(mainWindow, taskId)
    expect(task?.worktree_path).toContain(branchName)
  })

  test('create and verify branch exists in git', async ({ mainWindow }) => {
    // Ensure previous delete action fully detached worktree branch, if still present.
    const existing = await getTask(mainWindow, taskId)
    if (existing?.worktree_path) {
      await mainWindow.evaluate(
        async ({ repoPath, worktreePath, id }) => {
          await window
            .getTrpcVanillaClient()
            .worktrees.removeWorktree.mutate({ repoPath, worktreePath })
            .catch(() => {})
          await window.getTrpcVanillaClient().task.update.mutate({ id, worktreePath: null })
        },
        { repoPath: repoDir, worktreePath: existing.worktree_path, id: taskId }
      )
    }

    // Clean up branch from previous create/delete cycle
    try {
      execGit(`git branch -D ${branchName}`)
    } catch {
      /* ignore */
    }
    try {
      execGit('git worktree prune')
    } catch {
      /* ignore */
    }
    try {
      execSync(`rm -rf "${path.join(repoDir, 'worktrees')}"`, {
        cwd: repoDir,
        stdio: 'pipe'
      })
    } catch {
      /* ignore */
    }

    const targetPath = path.join(path.dirname(repoDir), branchName)
    const parentBranch = execGit('git branch --show-current').trim() || 'main'

    await mainWindow.evaluate(
      async ({ repoPath, targetPath, branch, taskId, parentBranch }) => {
        await window.getTrpcVanillaClient().worktrees.createWorktree.mutate({ repoPath, targetPath, branch })
        await window.getTrpcVanillaClient().task.update.mutate({
          id: taskId,
          worktreePath: targetPath,
          worktreeParentBranch: parentBranch
        })
      },
      { repoPath: repoDir, targetPath, branch: branchName, taskId, parentBranch }
    )
    await expect
      .poll(async () => {
        const task = await getTask(mainWindow, taskId)
        return task?.worktree_path ?? null
      })
      .toContain(branchName)

    // Verify branch was actually created in git
    await expect.poll(() => execGit('git branch')).toContain(branchName)

    // Verify worktree path stored in DB matches the explicit targetPath used above
    // (test exercises direct createWorktree, not the auto-create default template).
    const task = await getTask(mainWindow, taskId)
    const worktreePathFromDb = task?.worktree_path ?? ''
    const expectedWorktreePath = path.join(path.dirname(repoDir), branchName)
    expect(worktreePathFromDb).toBe(expectedWorktreePath)

    // Verify worktree dir exists on disk (read effective path from DB)
    const worktreePath =
      task?.worktree_path ?? path.join(repoDir, 'worktrees', branchName)
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
    const worktreePath = path.join(path.dirname(repoDir), branch)
    const parentBranch = execGit('git branch --show-current').trim()

    await mainWindow.evaluate(
      async ({ repoPath, targetPath, branch, taskId, parentBranch }) => {
        await window.getTrpcVanillaClient().worktrees.createWorktree.mutate({ repoPath, targetPath, branch })
        await window.getTrpcVanillaClient().task.update.mutate({
          id: taskId,
          worktreePath: targetPath,
          worktreeParentBranch: parentBranch
        })
      },
      {
        repoPath: repoDir,
        targetPath: worktreePath,
        branch,
        taskId: created.id,
        parentBranch
      }
    )

    await expect.poll(() => execGit('git worktree list --porcelain')).toContain(worktreePath)
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

    await expect.poll(() => execGit('git worktree list --porcelain')).not.toContain(worktreePath)
    await expect.poll(() => existsSync(worktreePath)).toBe(false)
  })

  test('deleting a task soft-deletes it and removes it from active lists', async ({
    mainWindow
  }) => {
    const s = seed(mainWindow)
    const projects = await s.getProjects()
    const project = projects.find((p: { name: string }) => p.name === 'Worktree Test')
    expect(project).toBeTruthy()

    const suffix = Date.now().toString()
    const branch = `delete-cleanup-${suffix}`
    const title = `Delete cleanup ${suffix}`
    const created = await s.createTask({ projectId: project!.id, title, status: 'todo' })
    const worktreePath = path.join(path.dirname(repoDir), branch)
    const parentBranch = execGit('git branch --show-current').trim()

    await mainWindow.evaluate(
      async ({ repoPath, targetPath, branch, taskId, parentBranch }) => {
        await window.getTrpcVanillaClient().worktrees.createWorktree.mutate({ repoPath, targetPath, branch })
        await window.getTrpcVanillaClient().task.update.mutate({
          id: taskId,
          worktreePath: targetPath,
          worktreeParentBranch: parentBranch
        })
      },
      {
        repoPath: repoDir,
        targetPath: worktreePath,
        branch,
        taskId: created.id,
        parentBranch
      }
    )

    await expect.poll(() => execGit('git worktree list --porcelain')).toContain(worktreePath)
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
        const active = await mainWindow.evaluate(() =>
          window.getTrpcVanillaClient().task.getAll.query()
        )
        return active.some((task) => task.id === created.id)
      })
      .toBe(false)

    await expect.poll(() => existsSync(worktreePath)).toBe(true)
  })
})
