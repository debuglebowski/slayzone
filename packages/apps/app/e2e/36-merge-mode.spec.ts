import { test, expect, seed, goHome, clickAll } from './fixtures/electron'
import { TEST_PROJECT_PATH } from './fixtures/electron'
import { execSync } from 'child_process'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import path from 'path'

const WORKTREE_DIR = path.join(TEST_PROJECT_PATH, 'worktrees')
const WORKTREE_PATH = path.join(WORKTREE_DIR, 'test-branch')

async function openTaskViaSearch(page: import('@playwright/test').Page, title: string) {
  await page.keyboard.press('Meta+k')
  const input = page.getByPlaceholder('Search tasks and projects...')
  await expect(input).toBeVisible()
  await input.fill(title)
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-testid="terminal-mode-trigger"]:visible').first()).toBeVisible({ timeout: 5_000 })
}

function git(cmd: string, cwd = TEST_PROJECT_PATH) {
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

function ensureRepo() {
  if (!existsSync(path.join(TEST_PROJECT_PATH, '.git'))) {
    git('git init')
    git('git config user.name "Test"')
    git('git config user.email "test@test.com"')
    git('git config commit.gpgsign false')
    writeFileSync(path.join(TEST_PROJECT_PATH, 'README.md'), '# test\n')
    git('git add README.md')
    git('git commit -m "Initial commit"')
  } else {
    try { git('git config commit.gpgsign false') } catch { /* ignore */ }
  }
}

let branchCounter = 0
let conflictCounter = 0
let conflictFile = 'base.txt'
function setupCleanBranch() {
  branchCounter++
  const main = getMainBranch()
  const filename = `feature-${branchCounter}.txt`
  git(`git checkout -b test-branch`)
  writeFileSync(path.join(TEST_PROJECT_PATH, filename), `feature content ${branchCounter}\n`)
  git(`git add ${filename}`)
  git(`git commit -m "add ${filename}"`)
  git(`git checkout ${main}`)
  mkdirSync(WORKTREE_DIR, { recursive: true })
  git(`git worktree add "${WORKTREE_PATH}" test-branch`)
}

function setupConflict() {
  conflictCounter++
  conflictFile = `base-${conflictCounter}.txt`
  const main = getMainBranch()
  writeFileSync(path.join(TEST_PROJECT_PATH, conflictFile), 'original\n')
  git(`git add ${conflictFile}`)
  try { git('git commit -m "base"') } catch { /* already committed */ }

  git('git checkout -b test-branch')
  writeFileSync(path.join(TEST_PROJECT_PATH, conflictFile), 'branch version\n')
  git(`git add ${conflictFile}`)
  git('git commit -m "branch change"')

  git(`git checkout ${main}`)
  writeFileSync(path.join(TEST_PROJECT_PATH, conflictFile), 'main version\n')
  git(`git add ${conflictFile}`)
  git('git commit -m "main change"')

  mkdirSync(WORKTREE_DIR, { recursive: true })
  git(`git worktree add "${WORKTREE_PATH}" test-branch`)
}

async function ensureConflictReady(page: import('@playwright/test').Page, taskId: string) {
  const conflicted = await page.evaluate(
    (pp) => window.api.git.getConflictedFiles(pp),
    TEST_PROJECT_PATH
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

  test.beforeAll(async ({ mainWindow }) => {
    ensureRepo()
    resetRepo()
    setupCleanBranch()

    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'CL merge', color: '#10b981', path: TEST_PROJECT_PATH })
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
    await mainWindow.getByRole('button', { name: new RegExp(`Merge into ${main}`) }).click()

    await mainWindow.getByRole('button', { name: 'Start Merge' }).click()

    // Success message
    const gitPanel = mainWindow.getByTestId('task-git-panel').last()
    await expect(gitPanel.getByText('Merged successfully')).toBeVisible()

    // Task marked done, merge_state stays null
    const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), taskId)
    expect(task?.status).toBe('done')
    expect(task?.merge_state).toBeNull()
  })
})

// ── Phase 1: Uncommitted changes ──────────────────────────────────

test.describe('Phase 1 — uncommitted changes', () => {
  let taskId: string
  let projectAbbrev: string

  test.beforeAll(async ({ mainWindow }) => {
    ensureRepo()
    resetRepo()
    setupCleanBranch()

    // Modify tracked file in worktree (unstaged change)
    writeFileSync(path.join(WORKTREE_PATH, 'README.md'), '# test\nmodified\n')

    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'DI merge', color: '#ef4444', path: TEST_PROJECT_PATH })
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

  test('clicking merge enters merge mode with uncommitted state', async ({ mainWindow }) => {
    const main = getMainBranch()
    await mainWindow.getByRole('button', { name: new RegExp(`Merge into ${main}`) }).click()

    await mainWindow.getByRole('button', { name: 'Start Merge' }).click()

    // Task should be in uncommitted merge state
    const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), taskId)
    expect(task?.merge_state).toBe('uncommitted')

    // Auto-switches to changes tab showing merge-mode banner
    await expect(mainWindow.getByText('Stage and commit your changes to continue the merge')).toBeVisible()
  })

  test('Cancel exits merge mode', async ({ mainWindow }) => {
    await mainWindow.getByRole('button', { name: 'Cancel' }).click()

    const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), taskId)
    expect(task?.merge_state).toBeNull()

    // Merge-mode banner should be gone
    await expect(mainWindow.getByText('Stage and commit your changes to continue the merge')).not.toBeVisible()
  })
})

// ── Phase 2: Conflict resolution ──────────────────────────────────

test.describe('Phase 2 — conflict resolution', () => {
  let taskId: string
  let projectAbbrev: string

  test.beforeAll(async ({ mainWindow }) => {
    ensureRepo()
    resetRepo()
    setupConflict()
    git('git merge --no-commit --no-ff test-branch || true')

    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'CF merge', color: '#dc2626', path: TEST_PROJECT_PATH })
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

    // Task should be in conflicts merge state
    const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), taskId)
    expect(task?.merge_state).toBe('conflicts')

    // Auto-switches to conflicts tab — Abort button visible in toolbar
    const gitPanel = mainWindow.getByTestId('task-git-panel').last()
    await expect(gitPanel.getByRole('button', { name: 'Abort' })).toBeVisible()
  })

  test('conflicted file list shows files', async ({ mainWindow }) => {
    await ensureConflictReady(mainWindow, taskId)
    const gitPanel = mainWindow.getByTestId('task-git-panel').last()
    const fileItem = gitPanel.locator('span.truncate').first()
    await expect(fileItem).toBeVisible({ timeout: 10_000 })
  })

  test('Accept Ours resolves the file', async ({ mainWindow }) => {
    await ensureConflictReady(mainWindow, taskId)
    const gitPanel = mainWindow.getByTestId('task-git-panel').last()
    const fileItem = gitPanel.locator('span.truncate').first()
    await fileItem.click()

    // Button uses dynamic branch name: "Accept {targetBranch}"
    const main = getMainBranch()
    await gitPanel.getByRole('button', { name: new RegExp(`Accept ${main}`) }).click()

    // File should be marked resolved
    await expect(gitPanel.getByText('File resolved and staged')).toBeVisible()
  })

  test('Complete Merge finishes and marks done', async ({ mainWindow }) => {
    const gitPanel = mainWindow.getByTestId('task-git-panel').last()
    await gitPanel.getByRole('button', { name: 'Complete Merge' }).click()

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
    ensureRepo()
    resetRepo()
    setupConflict()
    git('git merge --no-commit --no-ff test-branch || true')

    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'TH merge', color: '#f59e0b', path: TEST_PROJECT_PATH })
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

    // Toggle git panel on — conflicts tab auto-activates
    await mainWindow.keyboard.press('Meta+g')
    await expect(mainWindow.getByTestId('task-git-panel').last()).toBeVisible({ timeout: 5_000 })
  })

  test('Accept Theirs resolves with incoming content', async ({ mainWindow }) => {
    const gitPanel = mainWindow.getByTestId('task-git-panel').last()
    await gitPanel.locator('span.truncate').first().click()

    // Button uses dynamic branch name: "Accept {sourceBranch}"
    await gitPanel.getByRole('button', { name: /Accept test-branch/ }).click()

    await expect(gitPanel.getByText('File resolved and staged')).toBeVisible()

    // Complete merge
    await gitPanel.getByRole('button', { name: 'Complete Merge' }).click()

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
    ensureRepo()
    resetRepo()
    setupConflict()

    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'AB merge', color: '#64748b', path: TEST_PROJECT_PATH })
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

    // Enter merge mode → conflict
    const main = getMainBranch()
    await mainWindow.getByRole('button', { name: new RegExp(`Merge into ${main}`) }).click()
    await mainWindow.getByRole('button', { name: 'Start Merge' }).click()
  })

  test('Abort Merge clears merge state', async ({ mainWindow }) => {
    // Should be in conflict phase — Abort button visible in toolbar
    const gitPanel = mainWindow.getByTestId('task-git-panel').last()
    await expect(gitPanel.getByRole('button', { name: 'Abort' })).toBeVisible()

    await gitPanel.getByRole('button', { name: 'Abort' }).click()

    // merge_state cleared
    const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), taskId)
    expect(task?.merge_state).toBeNull()

    // Abort button gone (conflicts tab removed)
    await expect(gitPanel.getByRole('button', { name: 'Abort' })).not.toBeVisible()

    // Git merge not in progress
    const inProgress = await mainWindow.evaluate(
      (pp) => window.api.git.isMergeInProgress(pp),
      TEST_PROJECT_PATH
    )
    expect(inProgress).toBe(false)
  })
})

// ── Merge badge on kanban ─────────────────────────────────────────

test.describe('Merge badge on kanban', () => {
  let taskId: string
  let projectAbbrev: string

  test.beforeAll(async ({ mainWindow }) => {
    ensureRepo()
    resetRepo()
    setupConflict()

    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'BA merge', color: '#7c3aed', path: TEST_PROJECT_PATH })
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
    await clickAll(mainWindow)

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
    ensureRepo()
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
      { pp: TEST_PROJECT_PATH, fp: conflictFile }
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
