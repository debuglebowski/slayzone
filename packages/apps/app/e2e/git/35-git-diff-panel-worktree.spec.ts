import {
  test,
  expect,
  seed,
  resetApp,
  createIsolatedGitRepo
} from '../fixtures/electron'
import { pressShortcut } from '../fixtures/shortcuts'
import { execSync } from 'child_process'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import path from 'path'

let gitDir: string
let WORKTREE_DIR: string
let WORKTREE_PATH: string

function git(cmd: string, cwd = gitDir) {
  const safeCmd = cmd.replace(/^git /, 'git -c commit.gpgsign=false ')
  return execSync(safeCmd, { cwd, encoding: 'utf-8', stdio: 'pipe' })
}

function getMainBranch(): string {
  try {
    const branches = git('git branch')
    return branches.includes('main') ? 'main' : 'master'
  } catch {
    return 'main'
  }
}

async function openTaskViaSearch(page: import('@playwright/test').Page, title: string) {
  await pressShortcut(page, 'search')
  const input = page.getByPlaceholder('Search files, folders, commands, projects, and tasks...')
  await expect(input).toBeVisible()
  await input.fill(title)
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-testid="terminal-mode-trigger"]:visible').first()).toBeVisible({
    timeout: 5_000
  })
}

async function ensureDiffPanelVisible(page: import('@playwright/test').Page) {
  const target = page.locator('[data-testid="task-git-panel"]:visible').last()
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await target.isVisible({ timeout: 500 }).catch(() => false)) break
    await page.keyboard.press('Escape').catch(() => {})
    await page
      .locator('#root')
      .click({ position: { x: 16, y: 16 } })
      .catch(() => {})
    await page.keyboard.press('Meta+g')
  }
  await expect(target).toBeVisible({ timeout: 5_000 })
  // Switch to the "Diff" (Changes) tab
  await target.getByRole('button', { name: /^Diff(?:\s|$)/ }).click()
  await expect(page.getByTestId('git-diff-panel').last()).toBeVisible({ timeout: 5_000 })
}

const panel = (page: import('@playwright/test').Page) =>
  page.locator('[data-testid="git-diff-panel"]:visible')

const refresh = async (page: import('@playwright/test').Page) => {
  await page.getByTestId('task-git-panel').locator('button[aria-label="Refresh"]').click()
}

function cleanWorktreeAndMain() {
  // Reset worktree changes
  try {
    git('git checkout -- .', WORKTREE_PATH)
  } catch {
    /* ignore */
  }
  try {
    git('git clean -fd', WORKTREE_PATH)
  } catch {
    /* ignore */
  }
  // Reset main checkout changes (other than committed baseline + the worktrees dir itself)
  try {
    git('git checkout -- .')
  } catch {
    /* ignore */
  }
  try {
    git('git clean -fd -e worktrees')
  } catch {
    /* ignore */
  }
}

test.describe('Git diff panel — worktree task', () => {
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    gitDir = createIsolatedGitRepo('diff-panel-worktree')
    WORKTREE_DIR = path.join(gitDir, 'worktrees')
    WORKTREE_PATH = path.join(WORKTREE_DIR, 'feature-branch')

    // Reset to a known clean state
    try {
      git('git checkout -- .')
    } catch {
      /* ignore */
    }
    try {
      git('git clean -fd')
    } catch {
      /* ignore */
    }
    // Remove any prior worktree from a previous run
    try {
      git(`git worktree remove --force "${WORKTREE_PATH}"`)
    } catch {
      /* ignore */
    }
    try {
      rmSync(WORKTREE_DIR, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    try {
      git('git worktree prune')
    } catch {
      /* ignore */
    }
    try {
      git('git branch -D feature-branch')
    } catch {
      /* ignore */
    }

    // Baseline commit on main
    writeFileSync(path.join(gitDir, 'base.txt'), 'baseline\n')
    git('git add base.txt')
    try {
      git('git commit -m "baseline"')
    } catch {
      /* already committed */
    }

    // Create the worktree on a new branch
    mkdirSync(WORKTREE_DIR, { recursive: true })
    git(`git worktree add -b feature-branch "${WORKTREE_PATH}"`)

    // Create project + worktree-bound task
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'WT Diff', color: '#06b6d4', path: gitDir })
    const t = await s.createTask({ projectId: p.id, title: 'WT diff task', status: 'todo' })
    taskId = t.id
    await mainWindow.evaluate((d) => window.api.db.updateTask(d), {
      id: taskId,
      worktreePath: WORKTREE_PATH,
      worktreeParentBranch: getMainBranch()
    })
    await s.refreshData()

    await openTaskViaSearch(mainWindow, 'WT diff task')
    await ensureDiffPanelVisible(mainWindow)
  })

  test.afterAll(() => {
    cleanWorktreeAndMain()
    try {
      git(`git worktree remove --force "${WORKTREE_PATH}"`)
    } catch {
      /* ignore */
    }
    try {
      rmSync(WORKTREE_DIR, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    try {
      git('git worktree prune')
    } catch {
      /* ignore */
    }
    try {
      git('git branch -D feature-branch')
    } catch {
      /* ignore */
    }
  })

  test.beforeEach(() => {
    cleanWorktreeAndMain()
  })

  test('shows modified file from the worktree', async ({ mainWindow }) => {
    writeFileSync(path.join(WORKTREE_PATH, 'base.txt'), 'baseline\nmodified-in-worktree\n')
    await refresh(mainWindow)

    const p = panel(mainWindow)
    await expect(p.getByText('Unstaged')).toBeVisible({ timeout: 5_000 })
    const fileRow = p.locator('.font-mono.text-xs').filter({ hasText: 'base.txt' })
    await expect(fileRow).toBeVisible({ timeout: 5_000 })
    await expect(fileRow.locator('.font-bold').first()).toHaveText('M')

    // Click the file → diff body should show the new line
    await fileRow.click()
    await expect(p.getByText('modified-in-worktree')).toBeVisible({ timeout: 5_000 })
  })

  test('shows untracked file from the worktree', async ({ mainWindow }) => {
    writeFileSync(path.join(WORKTREE_PATH, 'wt-only.txt'), 'untracked worktree file\n')
    await refresh(mainWindow)

    const p = panel(mainWindow)
    const fileRow = p.locator('.font-mono.text-xs').filter({ hasText: 'wt-only.txt' })
    await expect(fileRow).toBeVisible({ timeout: 5_000 })
    await expect(fileRow.locator('.font-bold').first()).toHaveText('?')
  })

  test('shows worktree changes, NOT project-root changes', async ({ mainWindow }) => {
    // Decoy change in MAIN checkout — should NOT appear
    writeFileSync(path.join(gitDir, 'main-only.txt'), 'change in main checkout\n')
    // Real change in WORKTREE — should appear
    writeFileSync(path.join(WORKTREE_PATH, 'wt-target.txt'), 'change in worktree\n')

    await refresh(mainWindow)

    const p = panel(mainWindow)
    // Worktree file present
    await expect(
      p.locator('.font-mono.text-xs').filter({ hasText: 'wt-target.txt' })
    ).toBeVisible({ timeout: 5_000 })
    // Main-checkout file MUST be absent — proves diff is scoped to worktree
    await expect(
      p.locator('.font-mono.text-xs').filter({ hasText: 'main-only.txt' })
    ).toHaveCount(0)
  })
})

// ── Auto-created worktree on task create ──────────────────────────────

test.describe('Git diff panel — auto-created worktree', () => {
  let autoGitDir: string
  let autoWorktreePath: string

  function gitAuto(cmd: string, cwd = autoGitDir) {
    const safeCmd = cmd.replace(/^git /, 'git -c commit.gpgsign=false ')
    return execSync(safeCmd, { cwd, encoding: 'utf-8', stdio: 'pipe' })
  }

  function slugify(text: string): string {
    return text
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
  }

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    autoGitDir = createIsolatedGitRepo('diff-panel-auto-wt')

    // Baseline commit so HEAD exists (auto-create worktree requires HEAD)
    writeFileSync(path.join(autoGitDir, 'base.txt'), 'baseline\n')
    gitAuto('git add base.txt')
    try {
      gitAuto('git commit -m "baseline"')
    } catch {
      /* already */
    }

    const s = seed(mainWindow)
    await s.setSetting('worktree_base_path', '')
    await s.setSetting('auto_create_worktree_on_task_create', '1')

    const project = await s.createProject({
      name: 'AutoWT Diff',
      color: '#a855f6',
      path: autoGitDir
    })

    const title = `Auto WT Diff ${Date.now()}`
    const created = await s.createTask({
      projectId: project.id,
      title,
      status: 'todo'
    })

    // Wait for auto-worktree to land
    const expectedBranch = slugify(title)
    const projectFolder = path.basename(autoGitDir)
    autoWorktreePath = path.join(
      path.dirname(autoGitDir),
      `${projectFolder}-workspaces`,
      expectedBranch
    )
    await expect
      .poll(async () => {
        const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), created.id)
        return task?.worktree_path ?? null
      })
      .toBe(autoWorktreePath)

    await openTaskViaSearch(mainWindow, title)
    await ensureDiffPanelVisible(mainWindow)
  })

  test.afterAll(async ({ mainWindow }) => {
    const s = seed(mainWindow)
    await s.setSetting('auto_create_worktree_on_task_create', '0')
    try {
      gitAuto(`git worktree remove --force "${autoWorktreePath}"`)
    } catch {
      /* ignore */
    }
    try {
      rmSync(path.dirname(autoWorktreePath), { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    try {
      gitAuto('git worktree prune')
    } catch {
      /* ignore */
    }
  })

  test('shows changes from auto-created worktree', async ({ mainWindow }) => {
    writeFileSync(path.join(autoWorktreePath, 'base.txt'), 'baseline\nauto-mod\n')
    writeFileSync(path.join(autoWorktreePath, 'auto-new.txt'), 'new in auto worktree\n')

    await refresh(mainWindow)

    const p = panel(mainWindow)
    await expect(p.getByText('Unstaged')).toBeVisible({ timeout: 5_000 })
    await expect(
      p.locator('.font-mono.text-xs').filter({ hasText: 'base.txt' })
    ).toBeVisible({ timeout: 5_000 })
    await expect(
      p.locator('.font-mono.text-xs').filter({ hasText: 'auto-new.txt' })
    ).toBeVisible({ timeout: 5_000 })
  })
})

// ── Worktree attached AFTER the task tab is open (manual dialog flow) ──

test.describe('Git diff panel — worktree attached after open', () => {
  let manualGitDir: string
  let manualWorktreeDir: string
  let manualWorktreePath: string
  let manualTaskId: string

  function gitManual(cmd: string, cwd = manualGitDir) {
    const safeCmd = cmd.replace(/^git /, 'git -c commit.gpgsign=false ')
    return execSync(safeCmd, { cwd, encoding: 'utf-8', stdio: 'pipe' })
  }

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    manualGitDir = createIsolatedGitRepo('diff-panel-manual-wt')
    manualWorktreeDir = path.join(manualGitDir, 'worktrees')
    manualWorktreePath = path.join(manualWorktreeDir, 'manual-feature')

    // Baseline commit
    writeFileSync(path.join(manualGitDir, 'base.txt'), 'baseline\n')
    gitManual('git add base.txt')
    try {
      gitManual('git commit -m "baseline"')
    } catch {
      /* ignore */
    }

    // Cleanup any leftover from prior runs
    try {
      gitManual(`git worktree remove --force "${manualWorktreePath}"`)
    } catch {
      /* ignore */
    }
    try {
      rmSync(manualWorktreeDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    try {
      gitManual('git worktree prune')
    } catch {
      /* ignore */
    }
    try {
      gitManual('git branch -D manual-feature')
    } catch {
      /* ignore */
    }

    const s = seed(mainWindow)
    const project = await s.createProject({
      name: 'Manual WT Diff',
      color: '#eab308',
      path: manualGitDir
    })
    const t = await s.createTask({
      projectId: project.id,
      title: 'Manual WT task',
      status: 'todo'
    })
    manualTaskId = t.id
    await s.refreshData()

    await openTaskViaSearch(mainWindow, 'Manual WT task')
    await ensureDiffPanelVisible(mainWindow)
  })

  test.afterAll(() => {
    try {
      gitManual(`git worktree remove --force "${manualWorktreePath}"`)
    } catch {
      /* ignore */
    }
    try {
      rmSync(manualWorktreeDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    try {
      gitManual('git worktree prune')
    } catch {
      /* ignore */
    }
    try {
      gitManual('git branch -D manual-feature')
    } catch {
      /* ignore */
    }
  })

  test('diff panel switches to worktree after it is attached to the task', async ({
    mainWindow
  }) => {
    // 1. Before worktree: panel reads project root → working tree clean
    await refresh(mainWindow)
    await expect(panel(mainWindow).getByText('Working tree clean')).toBeVisible({ timeout: 5_000 })

    // 2. Create worktree via IPC (mirrors what the Create Worktree dialog does)
    mkdirSync(manualWorktreeDir, { recursive: true })
    await mainWindow.evaluate(
      ({ repoPath, targetPath, branch }) =>
        window.api.git.createWorktree({
          repoPath,
          targetPath,
          branch
        }),
      { repoPath: manualGitDir, targetPath: manualWorktreePath, branch: 'manual-feature' }
    )

    // 3. Attach worktree to the task (dialog's onCreated callback path)
    const mainBranch = gitManual('git branch').includes('main') ? 'main' : 'master'
    await mainWindow.evaluate((d) => window.api.db.updateTask(d), {
      id: manualTaskId,
      worktreePath: manualWorktreePath,
      worktreeParentBranch: mainBranch
    })
    const s = seed(mainWindow)
    await s.refreshData()

    // 4. Make a change in the new worktree
    writeFileSync(path.join(manualWorktreePath, 'base.txt'), 'baseline\nmanual-mod\n')

    // 5. Diff panel should now point at the worktree and show the change
    await refresh(mainWindow)
    const p = panel(mainWindow)
    await expect(p.getByText('Unstaged')).toBeVisible({ timeout: 10_000 })
    await expect(
      p.locator('.font-mono.text-xs').filter({ hasText: 'base.txt' })
    ).toBeVisible({ timeout: 10_000 })
  })
})

// ── Project root IS a linked worktree ────────────────────────────────

test.describe('Git diff panel — project root is a linked worktree', () => {
  let mainRepoDir: string
  let projectAsWorktreePath: string

  function gitWt(cmd: string, cwd = mainRepoDir) {
    const safeCmd = cmd.replace(/^git /, 'git -c commit.gpgsign=false ')
    return execSync(safeCmd, { cwd, encoding: 'utf-8', stdio: 'pipe' })
  }

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    mainRepoDir = createIsolatedGitRepo('diff-panel-project-is-wt-main')
    projectAsWorktreePath = path.join(path.dirname(mainRepoDir), 'project-as-worktree')

    // Cleanup
    try {
      gitWt(`git worktree remove --force "${projectAsWorktreePath}"`)
    } catch {
      /* ignore */
    }
    try {
      rmSync(projectAsWorktreePath, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    try {
      gitWt('git worktree prune')
    } catch {
      /* ignore */
    }
    try {
      gitWt('git branch -D project-branch')
    } catch {
      /* ignore */
    }

    // Baseline commit on main
    writeFileSync(path.join(mainRepoDir, 'base.txt'), 'baseline\n')
    gitWt('git add base.txt')
    try {
      gitWt('git commit -m "baseline"')
    } catch {
      /* ignore */
    }

    // Project lives at a LINKED worktree (not the main checkout)
    gitWt(`git worktree add -b project-branch "${projectAsWorktreePath}"`)

    const s = seed(mainWindow)
    const project = await s.createProject({
      name: 'WT Root Diff',
      color: '#14b8a6',
      path: projectAsWorktreePath
    })
    await s.createTask({ projectId: project.id, title: 'WT-root task', status: 'todo' })
    await s.refreshData()

    await openTaskViaSearch(mainWindow, 'WT-root task')
    await ensureDiffPanelVisible(mainWindow)
  })

  test.afterAll(() => {
    try {
      gitWt(`git worktree remove --force "${projectAsWorktreePath}"`)
    } catch {
      /* ignore */
    }
    try {
      rmSync(projectAsWorktreePath, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    try {
      gitWt('git worktree prune')
    } catch {
      /* ignore */
    }
    try {
      gitWt('git branch -D project-branch')
    } catch {
      /* ignore */
    }
  })

  test('shows changes when project.path is itself a linked worktree', async ({ mainWindow }) => {
    writeFileSync(
      path.join(projectAsWorktreePath, 'base.txt'),
      'baseline\nedit-in-worktree-project\n'
    )
    writeFileSync(path.join(projectAsWorktreePath, 'extra.txt'), 'new file in worktree project\n')

    await refresh(mainWindow)
    const p = panel(mainWindow)
    await expect(p.getByText('Unstaged')).toBeVisible({ timeout: 5_000 })
    await expect(
      p.locator('.font-mono.text-xs').filter({ hasText: 'base.txt' })
    ).toBeVisible({ timeout: 5_000 })
    await expect(
      p.locator('.font-mono.text-xs').filter({ hasText: 'extra.txt' })
    ).toBeVisible({ timeout: 5_000 })
  })
})

// ── Multi-repo wrapper, worktree on a child ──────────────────────────

test.describe('Git diff panel — multi-repo wrapper with worktree on child', () => {
  let wrapperDir: string
  let child1Dir: string
  let child2Dir: string
  let child1WorktreesDir: string
  let child1WorktreePath: string

  function gitIn(cwd: string, cmd: string) {
    const safeCmd = cmd.replace(/^git /, 'git -c commit.gpgsign=false ')
    return execSync(safeCmd, { cwd, encoding: 'utf-8', stdio: 'pipe' })
  }

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    // wrapperDir itself is NOT a git repo — createIsolatedGitRepo would mark it as one.
    // Use a sibling location instead.
    const base = createIsolatedGitRepo('diff-panel-multi-wrapper-base')
    wrapperDir = path.join(path.dirname(base), 'wrapper')
    rmSync(wrapperDir, { recursive: true, force: true })
    mkdirSync(wrapperDir, { recursive: true })

    child1Dir = path.join(wrapperDir, 'child1')
    child2Dir = path.join(wrapperDir, 'child2')
    mkdirSync(child1Dir, { recursive: true })
    mkdirSync(child2Dir, { recursive: true })

    for (const dir of [child1Dir, child2Dir]) {
      gitIn(dir, 'git init -b main')
      writeFileSync(path.join(dir, 'base.txt'), `baseline ${path.basename(dir)}\n`)
      gitIn(dir, 'git add base.txt')
      gitIn(dir, 'git -c user.email=t@t -c user.name=t commit -m "baseline"')
    }

    child1WorktreesDir = path.join(child1Dir, 'worktrees')
    child1WorktreePath = path.join(child1WorktreesDir, 'child1-feature')
    mkdirSync(child1WorktreesDir, { recursive: true })
    gitIn(child1Dir, `git worktree add -b child1-feature "${child1WorktreePath}"`)

    const s = seed(mainWindow)
    const project = await s.createProject({
      name: 'Multi WT Diff',
      color: '#f43f5e',
      path: wrapperDir
    })
    const t = await s.createTask({
      projectId: project.id,
      title: 'Multi WT task',
      status: 'todo',
      repoName: 'child1'
    })
    await mainWindow.evaluate((d) => window.api.db.updateTask(d), {
      id: t.id,
      worktreePath: child1WorktreePath,
      worktreeParentBranch: 'main'
    })
    await s.refreshData()

    await openTaskViaSearch(mainWindow, 'Multi WT task')
    await ensureDiffPanelVisible(mainWindow)
  })

  test.afterAll(() => {
    try {
      gitIn(child1Dir, `git worktree remove --force "${child1WorktreePath}"`)
    } catch {
      /* ignore */
    }
    try {
      rmSync(wrapperDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  test('shows worktree changes for a child-repo-bound task', async ({ mainWindow }) => {
    // Decoy edits in other repos in the wrapper
    writeFileSync(path.join(child1Dir, 'main-only.txt'), 'change in child1 main checkout\n')
    writeFileSync(path.join(child2Dir, 'child2-only.txt'), 'change in child2\n')
    // Real change in child1's worktree
    writeFileSync(path.join(child1WorktreePath, 'wt-target.txt'), 'change in child1 worktree\n')

    await refresh(mainWindow)
    const p = panel(mainWindow)
    await expect(
      p.locator('.font-mono.text-xs').filter({ hasText: 'wt-target.txt' })
    ).toBeVisible({ timeout: 5_000 })
    // Decoys MUST NOT appear — proves diff is scoped to the child's worktree
    await expect(
      p.locator('.font-mono.text-xs').filter({ hasText: 'main-only.txt' })
    ).toHaveCount(0)
    await expect(
      p.locator('.font-mono.text-xs').filter({ hasText: 'child2-only.txt' })
    ).toHaveCount(0)
  })
})
