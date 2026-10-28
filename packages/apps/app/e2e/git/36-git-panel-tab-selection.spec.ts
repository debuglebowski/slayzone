import type { Locator, Page } from '@playwright/test'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import {
  test,
  expect,
  seed,
  resetApp,
  openTaskById,
  createIsolatedGitRepo
} from '../fixtures/electron'
import { focusForAppShortcut } from '../fixtures/browser-view'
import { shortcutKey } from '../fixtures/shortcuts'

// Which tab the task git panel shows, and which one it saves (git_active_tab).
// Task tabs live in <Activity>: hiding one unmounts its effects, showing it again
// re-runs them.
//  - A merge with conflicts switches the panel to Conflicts once. Re-showing the task
//    tab must not take the user's own tab back (it did: the switch was an effect).
//  - A saved PR tab is hidden only until the GitHub remote is known. It must be shown
//    once it is, and the tab shown meanwhile must not be saved over it (it was, and
//    the panel then stayed on that tab).

const panels = (git: boolean) => ({
  terminal: true,
  browser: false,
  diff: git,
  settings: false,
  editor: false,
  artifacts: false,
  processes: false
})

/** The active task tab's git panel (hidden task tabs stay mounted, display:none). */
const gitPanel = (page: Page): Locator => page.locator('[data-testid="task-git-panel"]:visible')

/** A new repo per run: the per-worker runtime dir can outlive a run. */
function freshRepo(name: string): string {
  fs.rmSync(createIsolatedGitRepo(name), { recursive: true, force: true })
  return createIsolatedGitRepo(name)
}

function git(cwd: string, args: string): string {
  return execSync(`git -c commit.gpgsign=false ${args}`, { cwd, encoding: 'utf-8', stdio: 'pipe' })
}

const savedGitTab = (page: Page, taskId: string) =>
  page.evaluate(
    async (id) => (await window.getTrpcVanillaClient().task.get.query({ id }))?.git_active_tab,
    taskId
  )

/** Two frames: the effects of the last commit, and what they set, have rendered. */
const nextFrames = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  )

test.describe('Conflicts auto-switch across a task-tab switch', () => {
  let taskA = ''
  let taskB = ''

  async function showA(page: Page): Promise<void> {
    await openTaskById(page, taskA)
    await expect(gitPanel(page)).toBeVisible({ timeout: 10_000 })
  }

  /** Show B's tab (no git panel): A's tab is hidden once this returns. */
  async function showB(page: Page): Promise<void> {
    await openTaskById(page, taskB)
    await expect(gitPanel(page)).toHaveCount(0, { timeout: 10_000 })
  }

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const repo = freshRepo('tab-selection-merge')
    fs.writeFileSync(path.join(repo, 'conflict.txt'), 'base\n')
    git(repo, 'add conflict.txt')
    git(repo, 'commit -m base')
    git(repo, 'checkout -b feature')
    fs.writeFileSync(path.join(repo, 'conflict.txt'), 'feature\n')
    git(repo, 'commit -am feature')
    git(repo, 'checkout -')
    fs.writeFileSync(path.join(repo, 'conflict.txt'), 'main\n')
    git(repo, 'commit -am main')
    expect(() => git(repo, 'merge feature')).toThrow()

    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Tab Merge', color: '#0ea5e9', path: repo })
    taskA = (await s.createTask({ projectId: p.id, title: 'TS conflict task', status: 'todo' })).id
    taskB = (await s.createTask({ projectId: p.id, title: 'TS other task', status: 'todo' })).id
    await s.updateTask({ id: taskA, mergeState: 'conflicts', panelVisibility: panels(true) })
    await s.updateTask({ id: taskB, panelVisibility: panels(false) })
    await s.refreshData()
  })

  test("re-showing the task tab keeps the user's tab over Conflicts", async ({ mainWindow }) => {
    await showA(mainWindow)
    const panel = gitPanel(mainWindow)
    // The merge's conflicts open the Conflicts tab, and that switch is saved.
    await expect(panel.getByText('Complete Merge')).toBeVisible({ timeout: 10_000 })
    await expect.poll(() => savedGitTab(mainWindow, taskA)).toBe('conflicts')

    await panel.getByRole('button', { name: /^Diff/ }).click()
    await expect(panel.getByTestId('git-diff-panel')).toBeVisible()
    await expect.poll(() => savedGitTab(mainWindow, taskA)).toBe('changes')

    await showB(mainWindow)
    await showA(mainWindow)
    await nextFrames(mainWindow)
    await expect(panel.getByTestId('git-diff-panel')).toBeVisible()
    await expect(panel.getByText('Complete Merge')).toBeHidden()
    expect(await savedGitTab(mainWindow, taskA)).toBe('changes')
  })
})

// ⌘G / ⇧⌘G (TaskDetailPage toggleGitTab) ask the panel which tab it shows to decide
// between "switch to it" and "close the panel": the answer must be the tab on screen.
test.describe('Git panel shortcuts switch or close', () => {
  let taskId = ''

  const tabButton = (page: Page, name: RegExp): Locator =>
    gitPanel(page).getByRole('button', { name })
  const expectActive = async (page: Page, name: RegExp): Promise<void> => {
    await expect(tabButton(page, name)).toHaveClass(/shadow-sm/, { timeout: 5_000 })
  }
  const press = async (page: Page, id: string): Promise<void> => {
    await focusForAppShortcut(page)
    await page.keyboard.press(shortcutKey(id))
  }

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const repo = freshRepo('tab-selection-shortcuts')
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Tab Keys', color: '#14b8a6', path: repo })
    taskId = (await s.createTask({ projectId: p.id, title: 'TS keys task', status: 'todo' })).id
    await s.updateTask({ id: taskId, panelVisibility: panels(false) })
    await s.refreshData()
  })

  test('⌘G and ⇧⌘G open, switch, and close on the tab shown', async ({ mainWindow }) => {
    await openTaskById(mainWindow, taskId)
    await expect(gitPanel(mainWindow)).toHaveCount(0, { timeout: 10_000 })

    // Closed → ⌘G opens on General; ⌘G again (already on General) closes.
    await press(mainWindow, 'panel-git')
    await expect(gitPanel(mainWindow)).toBeVisible({ timeout: 10_000 })
    await expectActive(mainWindow, /^General/)
    await press(mainWindow, 'panel-git')
    await expect(gitPanel(mainWindow)).toHaveCount(0, { timeout: 5_000 })

    // Closed → ⇧⌘G opens on Changes ("Diff").
    await press(mainWindow, 'panel-git-diff')
    await expect(gitPanel(mainWindow)).toBeVisible({ timeout: 10_000 })
    await expectActive(mainWindow, /^Diff/)

    // Open on Changes → ⌘G switches to General (stays open), ⇧⌘G switches back.
    await press(mainWindow, 'panel-git')
    await expectActive(mainWindow, /^General/)
    await expect(gitPanel(mainWindow)).toBeVisible()
    await press(mainWindow, 'panel-git-diff')
    await expectActive(mainWindow, /^Diff/)

    // Open on Changes → ⇧⌘G (already there) closes.
    await press(mainWindow, 'panel-git-diff')
    await expect(gitPanel(mainWindow)).toHaveCount(0, { timeout: 5_000 })
  })

  // Opening the closed panel with a shortcut picks its tab, so it is the tab to
  // reopen on: it must be saved, not left at whatever was saved before.
  test('opening the closed panel with ⌘G saves the tab it opens on', async ({ mainWindow }) => {
    await seed(mainWindow).updateTask({ id: taskId, gitActiveTab: 'stash' })
    await seed(mainWindow).refreshData()
    await openTaskById(mainWindow, taskId)
    await expect(gitPanel(mainWindow)).toHaveCount(0, { timeout: 10_000 })
    expect(await savedGitTab(mainWindow, taskId)).toBe('stash')

    await press(mainWindow, 'panel-git')
    await expect(gitPanel(mainWindow)).toBeVisible({ timeout: 10_000 })
    await expectActive(mainWindow, /^General/)
    await expect.poll(() => savedGitTab(mainWindow, taskId)).toBe('general')

    await press(mainWindow, 'panel-git')
    await expect(gitPanel(mainWindow)).toHaveCount(0, { timeout: 5_000 })
  })
})

test.describe('Saved PR tab while the GitHub remote loads', () => {
  const PR_URL = 'https://github.com/slayzone-e2e/tab-restore/pull/1'
  let taskId = ''

  test.beforeAll(async ({ mainWindow }) => {
    // Also reloads the renderer: nothing about this repo is cached when the panel opens.
    await resetApp(mainWindow)
    const repo = freshRepo('tab-selection-pr')
    git(repo, 'remote add origin https://github.com/slayzone-e2e/tab-restore.git')

    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Tab PR', color: '#8b5cf6', path: repo })
    taskId = (await s.createTask({ projectId: p.id, title: 'TS pr task', status: 'todo' })).id
    await s.updateTask({
      id: taskId,
      prUrl: PR_URL,
      gitActiveTab: 'pr',
      panelVisibility: panels(true)
    })
    await s.refreshData()
  })

  test('opens on the saved PR tab once the remote is known, and keeps it saved', async ({
    mainWindow
  }) => {
    await openTaskById(mainWindow, taskId)
    const panel = gitPanel(mainWindow)
    await expect(panel).toBeVisible({ timeout: 10_000 })
    // The PR tab's own content, in either state gh leaves it: the linked PR's URL
    // (gh found, PR not loadable) or the missing-gh notice.
    await expect(
      panel.getByText(PR_URL).or(panel.getByText('GitHub CLI not found')).first()
    ).toBeVisible({ timeout: 15_000 })
    expect(await savedGitTab(mainWindow, taskId)).toBe('pr')
  })
})
