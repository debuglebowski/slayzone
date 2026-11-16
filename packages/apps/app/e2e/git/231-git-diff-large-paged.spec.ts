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
  let taskId: string
  let otherTaskId: string

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
    taskId = t.id
    otherTaskId = (await s.createTask({ projectId: p.id, title: 'Activity away', status: 'todo' }))
      .id
    // Make the away task's layout explicit, as in the task-tab Activity regressions.
    await s.updateTask({
      id: otherTaskId,
      panelVisibility: {
        terminal: true,
        browser: false,
        diff: false,
        settings: false,
        editor: false,
        artifacts: false,
        processes: false
      }
    })
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
    await expect(p.getByText('old line 0 ', { exact: false }).first()).toBeVisible()
    // Unified diff puts all deletions before additions. Reach the additions by
    // scrolling the real viewport; virtual rows outside it stay unmounted.
    await more.evaluate((button, deletedLines) => {
      const viewport = button.closest<HTMLElement>('.overflow-auto')
      const firstRow = viewport?.querySelector<HTMLElement>('[data-index]')
      if (!viewport || !firstRow) throw new Error('large diff viewport missing')
      viewport.scrollTop = deletedLines * firstRow.getBoundingClientRect().height
    }, LINES)
    await expect(p.getByText('new line 0 ', { exact: false }).first()).toBeVisible()
    await more.evaluate((button) => {
      const viewport = button.closest<HTMLElement>('.overflow-auto')
      if (!viewport) throw new Error('large diff viewport missing')
      viewport.scrollTop = 0
    })
    await expect(p.getByText('old line 0 ', { exact: false }).first()).toBeVisible()

    // Task tabs retain state in React Activity. Hide this completed preview, then add a
    // fresh untracked file: reactivation must reacquire a live loader, not the disposed one.
    await openTaskById(mainWindow, otherTaskId)
    await expect(mainWindow.locator('[data-testid="task-git-panel"]:visible')).toHaveCount(0)
    writeFileSync(path.join(gitDir, 'after-activity.txt'), 'Activity resumed diff preview\n')
    await openTaskById(mainWindow, taskId)
    await expect(p).toBeVisible()
    await row('after-activity.txt').click()
    await expect(
      p.getByText('Activity resumed diff preview', { exact: false }).first()
    ).toBeVisible({ timeout: 15_000 })
    await row('big.txt').click()
    await expect(more).toBeVisible({ timeout: 30_000 })
    await more.click()
    await expect(more).toHaveCount(0, { timeout: 30_000 })
  })
})
