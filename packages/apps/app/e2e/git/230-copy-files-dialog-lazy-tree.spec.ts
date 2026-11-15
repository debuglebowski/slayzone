/**
 * "Copy files to worktree" on a repo with a big ignored folder: the dialog opens an
 * index of the ignored files on the computer and loads a folder's children only when
 * it is expanded, page by page — never one whole tree over the hub ↔ computer link
 * (FU1 S6). Totals and presets still cover every ignored file, and the confirmed
 * selection is what lands in the new worktree.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import path from 'node:path'
import {
  test,
  expect,
  seed,
  goHome,
  clickProject,
  resetApp,
  createIsolatedGitRepo,
  openTaskById,
  taskWithPaths
} from '../fixtures/electron'

const PACKAGES = 1100 // wider than one page (1000) of a folder's children

test.describe('Copy files dialog: lazy ignored-file tree', () => {
  let repoDir: string
  let taskId: string
  let projectAbbrev: string

  test.beforeAll(async ({ mainWindow }) => {
    test.setTimeout(90_000)
    await resetApp(mainWindow)
    repoDir = createIsolatedGitRepo('copy-dialog-lazy')
    const git = (cmd: string) => execSync(cmd, { cwd: repoDir, stdio: 'pipe' })
    writeFileSync(path.join(repoDir, '.gitignore'), 'node_modules/\n.env*\n')
    git('git add .gitignore')
    git('git -c commit.gpgsign=false commit -qm "ignore rules" --allow-empty')
    for (let n = 0; n < PACKAGES; n++) {
      const dir = path.join(repoDir, 'node_modules', `pkg${n}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, 'index.js'), 'module.exports = 1\n')
    }
    writeFileSync(path.join(repoDir, '.env'), 'SECRET=1\n')

    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Copy Lazy', color: '#0ea5e9', path: repoDir })
    await s.setSetting('worktree_base_path', '')
    await s.setSetting('worktree_copy_behavior', 'ask')
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    const t = await s.createTask({ projectId: p.id, title: 'Lazy copy', status: 'todo' })
    taskId = t.id
    await s.refreshData()
    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await openTaskById(mainWindow, taskId)
    await mainWindow.keyboard.press('Meta+g')
    await expect(mainWindow.getByTestId('task-git-panel').last()).toBeVisible()
  })

  test('counts every ignored file, loads a folder page by page, copies the selection', async ({
    mainWindow
  }) => {
    test.setTimeout(90_000)
    await openTaskById(mainWindow, taskId)
    await mainWindow.getByRole('button', { name: /Branch to worktree/ }).click()

    const dialog = mainWindow.getByRole('dialog').filter({ hasText: 'Copy files to worktree' })
    await expect(dialog).toBeVisible()
    // Default preset "All ignored files": every file, though no folder is loaded.
    await expect(dialog.getByRole('button', { name: `Copy ${PACKAGES + 1} files` })).toBeVisible({
      timeout: 30_000
    })
    await expect(dialog.getByText(`${PACKAGES} files`)).toBeVisible()

    // Expanding the folder loads one page of it, with a way to the rest.
    await dialog.getByText('node_modules/').click()
    await expect(dialog.getByRole('button', { name: 'pkg0/ 1 file', exact: true })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Load more' })).toBeVisible()
    await dialog.getByRole('button', { name: 'Load more' }).click()
    await expect(dialog.getByRole('button', { name: 'Load more' })).toHaveCount(0)

    // A preset is matched over every ignored file by the index.
    await dialog.getByRole('combobox').click()
    await mainWindow.getByRole('option', { name: 'Env files only' }).click()
    const copy = dialog.getByRole('button', { name: 'Copy 1 file' })
    await expect(copy).toBeVisible()
    await copy.click()

    await expect
      .poll(async () => (await taskWithPaths(mainWindow, taskId))?.worktree_path ?? null, {
        timeout: 45_000
      })
      .not.toBeNull()
    const worktree = (await taskWithPaths(mainWindow, taskId))!.worktree_path as string
    await expect.poll(() => existsSync(path.join(worktree, '.env')), { timeout: 15_000 }).toBe(true)
    expect(existsSync(path.join(worktree, 'node_modules'))).toBe(false)
  })
})
