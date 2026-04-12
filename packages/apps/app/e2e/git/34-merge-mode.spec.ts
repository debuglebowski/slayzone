import { test, expect, seed, goHome, clickProject, resetApp, createIsolatedGitRepo } from '../fixtures/electron'
import { pressShortcut } from '../fixtures/shortcuts'
import { execSync } from 'child_process'
import { writeFileSync, mkdirSync } from 'fs'
import path from 'path'

let gitDir: string
let WORKTREE_DIR: string
let WORKTREE_PATH: string

async function openTaskViaSearch(page: import('@playwright/test').Page, title: string) {
  await pressShortcut(page, 'search')
  const input = page.getByPlaceholder('Search files, tasks, projects...')
  await expect(input).toBeVisible()
  await input.fill(title)
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-testid="terminal-mode-trigger"]:visible').first()).toBeVisible({ timeout: 5_000 })
}

function git(cmd: string, cwd = gitDir) {
  // Inject -c commit.gpgsign=false after 'git' to bypass 1Password GPG signing
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

function resetRepo() {
  try { git('git merge --abort') } catch { /* ignore */ }
  try {
    const mainWorktree = git('git rev-parse --show-toplevel').trim()
    const worktreeList = git('git worktree list --porcelain')
      .split('\n')
      .filter(line => line.startsWith('worktree '))
      .map(line => line.replace('worktree ', '').trim())
    for (const wt of worktreeList) {
      if (wt !== mainWorktree) {
        try { git(`git worktree remove --force "${wt}"`) } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  try { execSync(`rm -rf "${WORKTREE_DIR}"`) } catch { /* ignore */ }
  try { git('git worktree prune') } catch { /* ignore */ }
  try { git(`git checkout ${getMainBranch()}`) } catch { /* ignore */ }
  try { git('git branch -D test-branch') } catch { /* ignore */ }
  try { git('git reset --hard') } catch { /* ignore */ }
  try { git('git checkout -- .') } catch { /* ignore */ }
  try { git('git clean -fd') } catch { /* ignore */ }
  // Remove test artifacts that may have been merged onto main
  try {
    const tracked = git('git ls-files').split('\n')
    const artifacts = tracked.filter(
      f => f.startsWith('feature-') || f.startsWith('base-') || f === 'base.txt' || f === 'dirty.txt'
    )
    if (artifacts.length > 0) {
      git(`git rm -f ${artifacts.join(' ')}`)
      git('git commit -m "cleanup test artifacts"')
    }
  } catch { /* ignore */ }
}

function initGitDir() {
  gitDir = createIsolatedGitRepo('merge-mode')
  WORKTREE_DIR = path.join(gitDir, 'worktrees')
  WORKTREE_PATH = path.join(WORKTREE_DIR, 'test-branch')
}

let branchCounter = 0
let conflictCounter = 0
let conflictFile = 'base.txt'
function setupCleanBranch() {
  branchCounter++
  const main = getMainBranch()
  const filename = `feature-${branchCounter}.txt`
  git(`git checkout -b test-branch`)
  writeFileSync(path.join(gitDir, filename), `feature content ${branchCounter}\n`)
  git(`git add ${filename}`)
  git(`git commit -m "add ${filename}"`)
  git(`git checkout ${main}`)
  mkdirSync(WORKTREE_DIR, { recursive: true })
  git(`git worktree add "${WORKTREE_PATH}" test-branch`)
  return filename
}

function setupConflict() {
  conflictCounter++
  conflictFile = `base-${conflictCounter}.txt`
  const main = getMainBranch()
  writeFileSync(path.join(gitDir, conflictFile), 'original\n')
  git(`git add ${conflictFile}`)
  try { git('git commit -m "base"') } catch { /* already committed */ }

  git('git checkout -b test-branch')
  writeFileSync(path.join(gitDir, conflictFile), 'branch version\n')
  git(`git add ${conflictFile}`)
  git('git commit -m "branch change"')

  git(`git checkout ${main}`)
  writeFileSync(path.join(gitDir, conflictFile), 'main version\n')
  git(`git add ${conflictFile}`)
  git('git commit -m "main change"')

  mkdirSync(WORKTREE_DIR, { recursive: true })
  git(`git worktree add "${WORKTREE_PATH}" test-branch`)
}

async function ensureConflictReady(page: import('@playwright/test').Page, taskId: string) {
  const conflicted = await page.evaluate(
    (pp) => window.api.git.getConflictedFiles(pp),
    gitDir
  )
  if (conflicted.includes(conflictFile)) return

  try { git('git merge --abort') } catch { /* ignore */ }
  git('git merge --no-commit --no-ff test-branch || true')
  await page.evaluate(
    (d) => window.api.db.updateTask(d),
    { id: taskId, mergeState: 'conflicts' as const }
  )
  const s = seed(page)
  await s.refreshData()
}

// ── Clean merge skips merge mode ──────────────────────────────────

test.describe('Clean merge skips merge mode', () => {
  let taskId: string
  let projectAbbrev: string
  let mergedFile: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    initGitDir()
    resetRepo()
    mergedFile = setupCleanBranch()

    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'CL merge', color: '#10b981', path: gitDir })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    const t = await s.createTask({ projectId: p.id, title: 'MM clean task', status: 'todo' })
    taskId = t.id
    await mainWindow.evaluate(
      (d) => window.api.db.updateTask(d),
      { id: taskId, worktreePath: WORKTREE_PATH, worktreeParentBranch: getMainBranch() }
    )
    await s.refreshData()

    await openTaskViaSearch(mainWindow, 'MM clean task')

    // Toggle git panel on (general tab — shows merge controls)
    await mainWindow.keyboard.press('Meta+g')
    await expect(mainWindow.getByTestId('task-git-panel').last()).toBeVisible({ timeout: 5_000 })
  })

  test('clean merge auto-completes without entering merge mode', async ({ mainWindow }) => {
    const main = getMainBranch()
    await mainWindow.getByRole('button', { name: new RegExp(`Merge to ${main}`) }).click()
    await mainWindow.getByRole('button', { name: 'Merge & delete' }).click()

    // Merge mode is not entered and the feature commit lands on the parent branch
    await expect
      .poll(async () => {
        const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), taskId)
        let merged = false
        try {
          merged = git(`git show HEAD:${mergedFile}`).includes('feature content')
        } catch {
          merged = false
        }
        return { status: task?.status ?? null, mergeState: task?.merge_state ?? null, merged }
      })
      .toMatchObject({ status: 'todo', mergeState: null, merged: true })
  })
})

// ── Phase 1: Uncommitted changes ──────────────────────────────────

test.describe('Phase 1 — uncommitted changes', () => {
  let taskId: string
  let projectAbbrev: string

  test.beforeAll(async ({ mainWindow }) => {
    resetRepo()
    setupCleanBranch()

    // Modify tracked file in worktree (unstaged change)
    writeFileSync(path.join(WORKTREE_PATH, 'README.md'), '# test\nmodified\n')

    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'DI merge', color: '#ef4444', path: gitDir })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    const t = await s.createTask({ projectId: p.id, title: 'MM dirty task', status: 'todo' })
    taskId = t.id
    await mainWindow.evaluate(
      (d) => window.api.db.updateTask(d),
      { id: taskId, worktreePath: WORKTREE_PATH, worktreeParentBranch: getMainBranch() }
    )
    await s.refreshData()

    await openTaskViaSearch(mainWindow, 'MM dirty task')

    // Toggle git panel on (general tab — shows merge controls)
    await mainWindow.keyboard.press('Meta+g')
    await expect(mainWindow.getByTestId('task-git-panel').last()).toBeVisible({ timeout: 5_000 })
  })

  test('uncommitted merge state opens diff view with merge controls', async ({ mainWindow }) => {
    await mainWindow.evaluate(
      (d) => window.api.db.updateTask(d),
      { id: taskId, mergeState: 'uncommitted' as const }
    )
    const s = seed(mainWindow)
    await s.refreshData()

    await expect
      .poll(async () => {
        const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), taskId)
        return task?.merge_state ?? null
      })
      .toBe('uncommitted')

    await expect(mainWindow.getByTestId('git-diff-panel').last()).toBeVisible()
    await expect(mainWindow.getByText('Stage and commit your changes to continue the merge')).toBeVisible()
    await expect(mainWindow.getByRole('button', { name: 'Commit & Continue Merge' })).toBeVisible()
  })

  test('Cancel exits merge mode', async ({ mainWindow }) => {
    await mainWindow.getByTestId('git-diff-panel').last().getByRole('button', { name: 'Cancel' }).click()
    await mainWindow.getByRole('button', { name: 'Abort' }).click()

    await expect
      .poll(async () => {
        const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), taskId)
        return task?.merge_state ?? null
      }, { timeout: 10_000 })
      .toBeNull()
    await expect(mainWindow.getByText('Stage and commit your changes to continue the merge')).toHaveCount(0)
  })
})

// ── Phase 2: Conflict resolution ──────────────────────────────────

test.describe('Phase 2 — conflict resolution', () => {
  let taskId: string
  let projectAbbrev: string

  test.beforeAll(async ({ mainWindow }) => {
    resetRepo()
    setupConflict()
    git('git merge --no-commit --no-ff test-branch || true')

    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'CF merge', color: '#dc2626', path: gitDir })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    const t = await s.createTask({ projectId: p.id, title: 'MM conflict task', status: 'todo' })
    taskId = t.id
    await mainWindow.evaluate(
      (d) => window.api.db.updateTask(d),
      {
        id: taskId,
        worktreePath: WORKTREE_PATH,
        worktreeParentBranch: getMainBranch(),
        mergeState: 'conflicts' as const,
      }
    )
    await s.refreshData()

    await openTaskViaSearch(mainWindow, 'MM conflict task')

    // Toggle git panel on (general tab — shows merge controls)
    await mainWindow.keyboard.press('Meta+g')
    await expect(mainWindow.getByTestId('task-git-panel').last()).toBeVisible({ timeout: 5_000 })
  })

  test('enters conflict merge mode', async ({ mainWindow }) => {
    await expect
      .poll(async () => {
        const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), taskId)
        return task?.merge_state ?? null
      })
      .toBe('conflicts')
    await ensureConflictReady(mainWindow, taskId)

    await expect(mainWindow.getByRole('button', { name: /Conflicts/ })).toBeVisible()
    await expect(mainWindow.getByText('Complete Merge')).toBeVisible()
  })

  const activeConflictPanel = (page: import('@playwright/test').Page) =>
    page.getByTestId('task-git-panel').last()

  test('conflicted file list shows files', async ({ mainWindow }) => {
    await ensureConflictReady(mainWindow, taskId)
    const fileItem = activeConflictPanel(mainWindow).locator('span.truncate').filter({ hasText: conflictFile }).first()
    await expect(fileItem).toBeVisible({ timeout: 10_000 })
  })

  test('Accept Ours resolves the file', async ({ mainWindow }) => {
    await ensureConflictReady(mainWindow, taskId)
    const panel = activeConflictPanel(mainWindow)
    const fileItem = panel.locator('span.truncate').filter({ hasText: conflictFile }).first()
    await fileItem.click()

    // Click Accept Ours
    const acceptOurs = panel.getByRole('button', { name: new RegExp(`Accept ${getMainBranch()}`) })
    await expect(acceptOurs).toBeVisible({ timeout: 10_000 })
    await acceptOurs.click()

    // File should be marked resolved
    await expect(panel.getByText('File resolved and staged')).toBeVisible()
  })

  test('Complete Merge finishes and marks done', async ({ mainWindow }) => {
    const panel = activeConflictPanel(mainWindow)
    await panel.getByRole('button', { name: 'Complete Merge' }).click()

    await expect
      .poll(async () => {
        const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), taskId)
        return { status: task?.status ?? null, mergeState: task?.merge_state ?? null }
      })
      .toMatchObject({ status: 'done', mergeState: null })
  })
})

// ── Accept Theirs resolution ──────────────────────────────────────

test.describe('Accept Theirs resolution', () => {
  let taskId: string
  let projectAbbrev: string

  test.beforeAll(async ({ mainWindow }) => {
    resetRepo()
    setupConflict()
    git('git merge --no-commit --no-ff test-branch || true')

    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'TH merge', color: '#f59e0b', path: gitDir })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    const t = await s.createTask({ projectId: p.id, title: 'MM theirs task', status: 'todo' })
    taskId = t.id
    await mainWindow.evaluate(
      (d) => window.api.db.updateTask(d),
      {
        id: taskId,
        worktreePath: WORKTREE_PATH,
        worktreeParentBranch: getMainBranch(),
        mergeState: 'conflicts' as const,
      }
    )
    await s.refreshData()

    await openTaskViaSearch(mainWindow, 'MM theirs task')
    await mainWindow.keyboard.press('Meta+g')
    await expect(mainWindow.getByTestId('task-git-panel').last()).toBeVisible({ timeout: 5_000 })
  })

  test('Accept Theirs resolves with incoming content', async ({ mainWindow }) => {
    const panel = mainWindow.getByTestId('task-git-panel').last()
    await panel.locator('span.truncate').filter({ hasText: conflictFile }).first().click()

    const acceptTheirs = panel.getByRole('button', { name: /Accept test-branch/ })
    await expect(acceptTheirs).toBeVisible({ timeout: 10_000 })
    await acceptTheirs.click()

    await expect(mainWindow.getByText('File resolved and staged')).toBeVisible()

    // Complete merge
    await mainWindow.getByRole('button', { name: 'Complete Merge' }).click()

    // Verify theirs content on main
    await expect.poll(async () => {
      const content = git(`git show HEAD:${conflictFile}`)
      return content.trim()
    }, { timeout: 10_000 }).toBe('branch version')
  })
})

// ── Abort merge ───────────────────────────────────────────────────

test.describe('Abort merge', () => {
  let taskId: string
  let projectAbbrev: string

  test.beforeAll(async ({ mainWindow }) => {
    resetRepo()
    setupConflict()

    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'AB merge', color: '#64748b', path: gitDir })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    const t = await s.createTask({ projectId: p.id, title: 'MM abort task', status: 'todo' })
    taskId = t.id
    await mainWindow.evaluate(
      (d) => window.api.db.updateTask(d),
      { id: taskId, worktreePath: WORKTREE_PATH, worktreeParentBranch: getMainBranch() }
    )
    await s.refreshData()

    await openTaskViaSearch(mainWindow, 'MM abort task')

    // Toggle git panel on (general tab — shows merge controls)
    await mainWindow.keyboard.press('Meta+g')
    await expect(mainWindow.getByTestId('task-git-panel').last()).toBeVisible({ timeout: 5_000 })

    git('git merge --no-commit --no-ff test-branch || true')
    await mainWindow.evaluate(
      (d) => window.api.db.updateTask(d),
      { id: taskId, mergeState: 'conflicts' as const }
    )
    const s2 = seed(mainWindow)
    await s2.refreshData()
  })

  test('Abort Merge clears merge state', async ({ mainWindow }) => {
    await expect(mainWindow.getByRole('button', { name: /Conflicts/ })).toBeVisible()

    await mainWindow.getByTestId('task-git-panel').last().getByRole('button', { name: 'Abort', exact: true }).click()

    await expect
      .poll(async () => {
        const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), taskId)
        return task?.merge_state ?? null
      })
      .toBeNull()

    // Git merge not in progress
    const inProgress = await mainWindow.evaluate(
      (pp) => window.api.git.isMergeInProgress(pp),
      gitDir
    )
    expect(inProgress).toBe(false)
  })
})

// ── Merge badge on kanban ─────────────────────────────────────────

test.describe('Merge badge on kanban', () => {
  let taskId: string
  let projectAbbrev: string

  test.beforeAll(async ({ mainWindow }) => {
    resetRepo()
    setupConflict()

    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'BA merge', color: '#7c3aed', path: gitDir })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    const t = await s.createTask({ projectId: p.id, title: 'MM badge task', status: 'todo' })
    taskId = t.id
    await mainWindow.evaluate(
      (d) => window.api.db.updateTask(d),
      { id: taskId, worktreePath: WORKTREE_PATH, worktreeParentBranch: getMainBranch() }
    )
    await s.refreshData()
  })

  test('merge badge appears when task is in merge mode', async ({ mainWindow }) => {
    // Set merge_state directly
    await mainWindow.evaluate(
      (d) => window.api.db.updateTask(d),
      { id: taskId, mergeState: 'conflicts' as const }
    )
    const s = seed(mainWindow)
    await s.refreshData()

    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)

    const card = mainWindow.locator('.cursor-grab:visible').filter({ hasText: 'MM badge task' }).first()
    await expect(card).toBeVisible()
    const mergeIcon = card.locator('.lucide-git-merge').first()
    await expect(mergeIcon).toBeVisible()
  })

  test('merge badge disappears when merge_state cleared', async ({ mainWindow }) => {
    await mainWindow.evaluate(
      (d) => window.api.db.updateTask(d),
      { id: taskId, mergeState: null }
    )
    const s = seed(mainWindow)
    await s.refreshData()

    // Verify badge is gone for this task's card
    const card = mainWindow.locator('.cursor-grab:visible').filter({ hasText: 'MM badge task' }).first()
    await expect(card).toBeVisible()
    const mergeIcon = card.locator('.lucide-git-merge')
    await expect(mergeIcon).toHaveCount(0)
  })
})

// ── Backend API: getConflictContent ───────────────────────────────

test.describe('getConflictContent API', () => {
  test.beforeAll(async ({ mainWindow }) => {
    resetRepo()
    setupConflict()

    // Start merge to create conflict state
    const main = getMainBranch()
    git(`git merge --no-commit --no-ff test-branch || true`)

    const s = seed(mainWindow)
    await s.refreshData()
  })

  test('returns ours, theirs, base, merged fields', async ({ mainWindow }) => {
    const content = await mainWindow.evaluate(
      ({ pp, fp }) => window.api.git.getConflictContent(pp, fp),
      { pp: gitDir, fp: conflictFile }
    )

    expect(content.path).toBe(conflictFile)
    expect(content.ours).toContain('main version')
    expect(content.theirs).toContain('branch version')
    expect(content.base).toContain('original')
    // merged has conflict markers
    expect(content.merged).toContain('<<<<<<<')
    expect(content.merged).toContain('>>>>>>>')
  })

  test.afterAll(() => {
    try { git('git merge --abort') } catch { /* ignore */ }
  })
})
