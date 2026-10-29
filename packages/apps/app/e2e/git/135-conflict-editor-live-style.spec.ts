import {
  test,
  expect,
  seed,
  resetApp,
  createIsolatedGitRepo,
  openTaskByTitle
} from '../fixtures/electron'
import { execSync } from 'child_process'
import { writeFileSync, mkdirSync } from 'fs'
import path from 'path'

let gitDir: string
let WORKTREE_DIR: string
let WORKTREE_PATH: string

// Deterministic open by title (resolves id, then opens by id). Replaces the old
// search-dialog + Enter open, which flaked under full-suite load. See openTaskByTitle.
async function openTaskViaSearch(page: import('@playwright/test').Page, title: string) {
  await openTaskByTitle(page, title)
}

async function ensureGitPanelVisible(page: import('@playwright/test').Page) {
  const target = page.locator('[data-testid="task-git-panel"]:visible').last()
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await target.isVisible({ timeout: 500 }).catch(() => false)) return
    await page.keyboard.press('Escape').catch(() => {})
    await page
      .locator('#root')
      .click({ position: { x: 16, y: 16 } })
      .catch(() => {})
    await page.keyboard.press('Meta+g')
  }
  await expect(target).toBeVisible({ timeout: 5_000 })
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
  // Lazy-init: when running a subset of describes via --grep, the first
  // describe's beforeAll may not run, leaving gitDir undefined.
  if (!gitDir) initGitDir()
  try {
    git('git merge --abort')
  } catch {
    /* ignore */
  }
  try {
    const mainWorktree = git('git rev-parse --show-toplevel').trim()
    const worktreeList = git('git worktree list --porcelain')
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.replace('worktree ', '').trim())
    for (const wt of worktreeList) {
      if (wt !== mainWorktree) {
        try {
          git(`git worktree remove --force "${wt}"`)
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
  try {
    execSync(`rm -rf "${WORKTREE_DIR}"`)
  } catch {
    /* ignore */
  }
  try {
    git('git worktree prune')
  } catch {
    /* ignore */
  }
  try {
    git(`git checkout ${getMainBranch()}`)
  } catch {
    /* ignore */
  }
  try {
    git('git branch -D test-branch')
  } catch {
    /* ignore */
  }
  try {
    git('git reset --hard')
  } catch {
    /* ignore */
  }
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
  // Remove test artifacts that may have been merged onto main
  try {
    const tracked = git('git ls-files').split('\n')
    const artifacts = tracked.filter(
      (f) =>
        f.startsWith('feature-') || f.startsWith('base-') || f === 'base.txt' || f === 'dirty.txt'
    )
    if (artifacts.length > 0) {
      git(`git rm -f ${artifacts.join(' ')}`)
      git('git commit -m "cleanup test artifacts"')
    }
  } catch {
    /* ignore */
  }
}

function initGitDir() {
  gitDir = createIsolatedGitRepo('merge-mode')
  WORKTREE_DIR = path.join(gitDir, 'worktrees')
  WORKTREE_PATH = path.join(WORKTREE_DIR, 'test-branch')
}

let conflictCounter = 0
let conflictFile = 'base.txt'
function setupConflict() {
  conflictCounter++
  conflictFile = `base-${conflictCounter}.txt`
  const main = getMainBranch()
  writeFileSync(path.join(gitDir, conflictFile), 'original\n')
  git(`git add ${conflictFile}`)
  try {
    git('git commit -m "base"')
  } catch {
    /* already committed */
  }

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

// The conflict editor follows the editor font size (and theme) live: a change
// restyles the open view in place, keeping in-progress resolution edits. It
// used to keep the styles it was created with until the file was reopened.
test.describe('Conflict editor live styles', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    resetRepo()
    setupConflict()
    git('git merge --no-commit --no-ff test-branch || true')

    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'CF style', color: '#dc2626', path: gitDir })
    const t = await s.createTask({ projectId: p.id, title: 'CF style task', status: 'todo' })
    await mainWindow.evaluate((d) => window.getTrpcVanillaClient().task.update.mutate(d), {
      id: t.id,
      worktreePath: WORKTREE_PATH,
      worktreeParentBranch: getMainBranch(),
      mergeState: 'conflicts' as const
    })
    await mainWindow.evaluate(() =>
      window.getTrpcVanillaClient().settings.set.mutate({ key: 'editor_font_size', value: '13' })
    )
    await s.refreshData()
    await openTaskViaSearch(mainWindow, 'CF style task')
    await ensureGitPanelVisible(mainWindow)
  })

  test.afterAll(async ({ mainWindow }) => {
    await mainWindow.evaluate(async () => {
      await window
        .getTrpcVanillaClient()
        .settings.set.mutate({ key: 'editor_font_size', value: '13' })
      window.dispatchEvent(new Event('sz:settings-changed'))
    })
  })

  test('a font size change restyles the open editor and keeps the edit', async ({ mainWindow }) => {
    const panel = mainWindow.getByTestId('task-git-panel').last()
    await panel.locator('span.truncate').filter({ hasText: conflictFile }).first().click()
    const editor = panel.locator('.cm-editor').first()
    await expect(editor).toBeVisible({ timeout: 10_000 })
    await expect(editor).toHaveCSS('font-size', '13px')

    await editor.locator('.cm-content').click()
    await mainWindow.keyboard.press('Meta+ArrowUp')
    await mainWindow.keyboard.type('EDITED-')
    await expect(editor.locator('.cm-content')).toContainText('EDITED-')

    await mainWindow.evaluate(async () => {
      await window
        .getTrpcVanillaClient()
        .settings.set.mutate({ key: 'editor_font_size', value: '19' })
      window.dispatchEvent(new Event('sz:settings-changed'))
    })

    await expect(editor).toHaveCSS('font-size', '19px', { timeout: 5_000 })
    await expect(editor.locator('.cm-content')).toContainText('EDITED-')
  })
})
