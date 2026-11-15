/**
 * A working diff larger than one page (FU1 S5): the snapshot carries whole files up
 * to its budget and lists the rest; the panel loads the rest per file. A file whose
 * own patch is over the budget shows its first page with "Load rest of diff (X MB)",
 * which loads the remainder. No reply ever carries the whole diff.
 */
import { writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import path from 'node:path'
import {
  test,
  expect,
  seed,
  resetApp,
  createIsolatedGitRepo,
  openTaskById
} from '../fixtures/electron'

const LINES = 36_000 // ×2 sides × ~80 B ≈ 5.8 MB of patch: over the 4 MiB page
const pad = 'x'.repeat(64)
const body = (tag: string) =>
  Array.from({ length: LINES }, (_, n) => `${tag} line ${n} ${pad}`).join('\n') + '\n'

test.describe('Git diff panel: a diff over one page', () => {
  let gitDir: string

  test.beforeAll(async ({ mainWindow }) => {
    test.setTimeout(90_000)
    await resetApp(mainWindow)
    gitDir = createIsolatedGitRepo('diff-large-paged')
    const git = (cmd: string) => execSync(cmd, { cwd: gitDir, stdio: 'pipe' })
    writeFileSync(path.join(gitDir, 'big.txt'), body('old'))
    writeFileSync(path.join(gitDir, 'small.txt'), 'small\n')
    git('git add big.txt small.txt')
    git('git -c commit.gpgsign=false commit -qm "big + small"')
    writeFileSync(path.join(gitDir, 'big.txt'), body('new'))
    writeFileSync(path.join(gitDir, 'small.txt'), 'small changed\n')

    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Diff Large', color: '#f97316', path: gitDir })
    const t = await s.createTask({ projectId: p.id, title: 'Large diff', status: 'todo' })
    await s.refreshData()
    await openTaskById(mainWindow, t.id)
    await mainWindow.keyboard.press('Meta+g')
    await expect(mainWindow.getByTestId('task-git-panel')).toBeVisible({ timeout: 5_000 })
    await mainWindow
      .getByTestId('task-git-panel')
      .getByRole('button', { name: /^Diff(?:\s|$)/ })
      .click()
    await expect(mainWindow.getByTestId('git-diff-panel').last()).toBeVisible({ timeout: 5_000 })
  })

  const panel = (page: import('@playwright/test').Page) =>
    page.locator('[data-testid="git-diff-panel"]:visible')

  test('every file listed; a deferred file loads; a large one by its first page, then the rest', async ({
    mainWindow
  }) => {
    test.setTimeout(90_000)
    const p = panel(mainWindow)
    const row = (name: string) => p.locator('.font-mono.text-xs').filter({ hasText: name })

    // The small file's patch was left out of the snapshot (it comes after the big
    // one) and loads per file.
    await row('small.txt').click()
    await expect(p.getByText('small changed')).toBeVisible({ timeout: 30_000 })

    // The big file: its first page, and the way to the rest.
    await row('big.txt').click()
    const more = p.getByRole('button', { name: /^Load rest of diff \(\d+\.\d (KB|MB)\)$/ })
    await expect(more).toBeVisible({ timeout: 30_000 })
    await expect(p.getByText('new line 0 ', { exact: false }).first()).toBeVisible()
    await more.click()
    await expect(more).toHaveCount(0, { timeout: 30_000 })
  })
})
