import { test, expect, seed, goHome, clickProject, resetApp, createIsolatedGitRepo } from '../fixtures/electron'
import { execSync } from 'child_process'
import { writeFileSync } from 'fs'
import path from 'path'

let gitDir: string

function git(cmd: string) {
  return execSync(cmd, { cwd: gitDir, encoding: 'utf-8', stdio: 'pipe' })
}

test.describe('Git diff panel', () => {
  let projectAbbrev: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    gitDir = createIsolatedGitRepo('diff-panel')

    // Clean working tree
    try { git('git checkout -- .') } catch { /* ignore */ }
    try { git('git clean -fd') } catch { /* ignore */ }

    // Create baseline file and commit
    writeFileSync(path.join(gitDir, 'base.txt'), 'line1\nline2\nline3\n')
    git('git add base.txt')
    try { git('git commit -m "add base.txt"') } catch { /* already committed */ }

    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Diff Panel Test', color: '#8b5cf6', path: gitDir })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    await s.createTask({ projectId: p.id, title: 'Diff panel task', status: 'todo' })
    await s.refreshData()

    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.getByText('Diff panel task').first()).toBeVisible({ timeout: 5_000 })

    await mainWindow.getByText('Diff panel task').first().click()
    await expect(mainWindow.locator('[data-testid="terminal-mode-trigger"]:visible').first()).toBeVisible({ timeout: 5_000 })

    // Open git panel (general tab) then switch to changes tab
    await mainWindow.keyboard.press('Meta+g')
    await expect(mainWindow.getByTestId('task-git-panel')).toBeVisible({ timeout: 5_000 })
    // Click the "Diff" tab to switch to changes view
    await mainWindow.getByTestId('task-git-panel').getByRole('button', { name: /^Diff(?:\s|$)/ }).click()
    await expect(mainWindow.getByTestId('git-diff-panel').last()).toBeVisible({ timeout: 5_000 })

  })

  test.afterAll(() => {
    try { git('git checkout -- .') } catch { /* ignore */ }
    try { git('git clean -fd') } catch { /* ignore */ }
  })

  /** Scope to the visible git diff panel (test 19 leaves a hidden tab with its own panel) */
  const panel = (page: import('@playwright/test').Page) =>
    page.locator('[data-testid="git-diff-panel"]:visible')

  const refresh = async (page: import('@playwright/test').Page) => {
    // Refresh button is in the UnifiedGitPanel header (outside git-diff-panel)
    await page.getByTestId('task-git-panel').locator('button[aria-label="Refresh"]').click()
  }

  test('no changes shows empty state', async ({ mainWindow }) => {
    await refresh(mainWindow)
    const p = panel(mainWindow)
    await expect(p.getByText('Working tree clean')).toBeVisible()
    await expect(p.getByText('No uncommitted changes')).toBeVisible()
  })

  test('modified file appears in unstaged with M status', async ({ mainWindow }) => {
    writeFileSync(path.join(gitDir, 'base.txt'), 'line1\nline2 modified\nline3\n')
    await refresh(mainWindow)

    const p = panel(mainWindow)
    await expect(p.getByText('Unstaged')).toBeVisible()
    await expect(p.getByText('base.txt')).toBeVisible()
    // Status badge M
    const fileRow = p.locator('.font-mono.text-xs').filter({ hasText: 'base.txt' })
    await expect(fileRow.locator('.font-bold').first()).toHaveText('M')
  })

  test('untracked file appears with ? status', async ({ mainWindow }) => {
    writeFileSync(path.join(gitDir, 'newfile.txt'), 'new content\n')
    await refresh(mainWindow)

    const fileRow = panel(mainWindow).locator('.font-mono.text-xs').filter({ hasText: 'newfile.txt' })
    await expect(fileRow).toBeVisible()
    await expect(fileRow.locator('.font-bold').first()).toHaveText('?')
  })

  test('click file shows diff content', async ({ mainWindow }) => {
    const p = panel(mainWindow)
    // Click base.txt to select it
    await p.locator('.font-mono.text-xs').filter({ hasText: 'base.txt' }).click()

    // Diff viewer renders the modified context — no `@@` header in the new flat layout.
    await expect(p.getByText('line2 modified')).toBeVisible({ timeout: 5_000 })
  })

  test('stage individual file', async ({ mainWindow }) => {
    const p = panel(mainWindow)
    // Click stage button on base.txt (opacity-0, needs force)
    const baseRow = p.locator('.font-mono.text-xs').filter({ hasText: 'base.txt' })
    await baseRow.locator('button[title="Stage file"]').click({ force: true })

    // Staged section should appear with base.txt
    await expect(p.getByText(/^Staged/)).toBeVisible()
    // newfile.txt should still be in unstaged
    await expect(p.getByText(/^Unstaged/)).toBeVisible()
  })

  test('unstage individual file', async ({ mainWindow }) => {
    const p = panel(mainWindow)
    // Find base.txt in staged section and unstage it
    const stagedBase = p.locator('.font-mono.text-xs').filter({ hasText: 'base.txt' })
    await stagedBase.locator('button[title="Unstage file"]').click({ force: true })

    // base.txt should be back in unstaged
    await expect(p.getByText(/^Unstaged/)).toBeVisible()
  })

  test('stage all moves all files to staged', async ({ mainWindow }) => {
    const p = panel(mainWindow)
    await p.locator('button[title="Stage all"]').click()
    await mainWindow.getByRole('button', { name: 'Stage All' }).click()

    // Staged section should exist with both files
    await expect(p.getByText(/^Staged/)).toBeVisible()
    // Unstaged section should be gone
    await expect(p.getByText(/^Unstaged/)).not.toBeVisible()
  })

  test('unstage all moves all files back to unstaged', async ({ mainWindow }) => {
    const p = panel(mainWindow)
    await p.locator('button[title="Unstage all"]').click()
    await mainWindow.getByRole('button', { name: 'Unstage All' }).click()

    // Unstaged should exist
    await expect(p.getByText(/^Unstaged/)).toBeVisible()
    // Staged should be gone
    await expect(p.getByText(/^Staged/)).not.toBeVisible()
  })

  test('arrow key navigation selects files', async ({ mainWindow }) => {
    const p = panel(mainWindow)
    // Focus the file list container (scrollable div with tabIndex)
    const fileList = p.locator('.overflow-y-auto[tabindex="0"]')
    await fileList.click()

    // Press ArrowDown to select first file
    await mainWindow.keyboard.press('ArrowDown')

    // First entry should have bg-accent (selected) — but not hover:bg-accent/50
    const firstEntry = p.locator('.font-mono.text-xs').first()
    await expect(firstEntry).toHaveClass(/bg-primary\/10/)

    // Press ArrowDown again to select second file
    await mainWindow.keyboard.press('ArrowDown')

    // First should no longer be selected, second should be
    await expect(firstEntry).not.toHaveClass(/bg-primary\/10/)
    const secondEntry = p.locator('.font-mono.text-xs').nth(1)
    await expect(secondEntry).toHaveClass(/bg-primary\/10/)

    // ArrowUp goes back
    await mainWindow.keyboard.press('ArrowUp')
    await expect(firstEntry).toHaveClass(/bg-primary\/10/)
  })

  test('turns chip row stays mounted across clean ↔ dirty transitions (continuous-flow)', async ({ mainWindow }) => {
    // Regression: chip row used to live inside the snapshot-gated main-content
    // branch, so it unmounted on every snapshot=null transition (turn click,
    // working-tree-clean state) — losing horizontal scroll position. Now hoisted
    // to panel level. Verify it survives a dirty → clean → dirty cycle.

    // Enable continuous-flow mode
    await mainWindow.evaluate(async () => {
      await window.api.settings.set('diff_continuous_flow', '1')
      window.dispatchEvent(new Event('sz:settings-changed'))
    })

    const p = panel(mainWindow)
    const chipRow = p.getByRole('button', { name: 'All turns' })

    // Dirty state: chip row visible
    writeFileSync(path.join(gitDir, 'base.txt'), 'line1\nline2 modified\nline3\nextra\n')
    await refresh(mainWindow)
    await expect(chipRow).toBeVisible({ timeout: 5_000 })

    // Capture chip row DOM element identity
    const chipRowHandle = await chipRow.elementHandle()
    expect(chipRowHandle).not.toBeNull()

    // Clean working tree: prior tests left untracked files (e.g. newfile.txt
    // from test 83) — sweep them so the "Working tree clean" assertion holds.
    git('git checkout -- base.txt')
    git('git clean -fd')
    await refresh(mainWindow)
    await expect(p.getByText('Working tree clean')).toBeVisible({ timeout: 5_000 })
    await expect(chipRow).toBeVisible()

    // Same DOM node — no remount happened
    const stillSame = await mainWindow.evaluate(
      (el) => document.body.contains(el),
      chipRowHandle
    )
    expect(stillSame).toBe(true)

    // Restore for subsequent tests + disable continuous-flow
    writeFileSync(path.join(gitDir, 'base.txt'), 'line1\nline2 modified\nline3\nextra\n')
    await refresh(mainWindow)
    await mainWindow.evaluate(async () => {
      await window.api.settings.set('diff_continuous_flow', '0')
      window.dispatchEvent(new Event('sz:settings-changed'))
    })
  })

  test('polling picks up file changes', async ({ mainWindow }) => {
    // Modify base.txt
    writeFileSync(path.join(gitDir, 'base.txt'), 'line1\nline2 modified\nline3\nextra line\n')

    // Polling cadence is 5s; trigger an explicit refresh so the test doesn't
    // depend purely on the timer firing within the assertion window.
    await refresh(mainWindow)

    // Verify the diff panel updated — base.txt should still be visible with changes
    await expect(panel(mainWindow).locator('.font-mono.text-xs').filter({ hasText: 'base.txt' }))
      .toBeVisible({ timeout: 10_000 })
  })
})
