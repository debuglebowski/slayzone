import type { Page } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import {
  test,
  expect,
  seed,
  goHome,
  clickProject,
  resetApp,
  createIsolatedGitRepo
} from '../fixtures/electron'

// The project git panel's General tab (home → Git) refreshes its status on a git
// change under the project path (the shared fs watcher), not only on its poll — which
// backs off to 60s while nothing changes. Before, an edit made outside the app showed
// only on the next poll: up to a minute late.

/** Locate a home panel toggle button by label (same as 67-home-panel-persistence). */
const homePanelBtn = (page: Page, label: string) =>
  page
    .locator('.bg-surface-2.rounded-lg')
    .filter({ has: page.locator(`button:has-text("Kanban")`) })
    .locator(`button:has-text("${label}")`)

const shown = (page: Page, text: string) =>
  page.getByText(text, { exact: true }).filter({ visible: true })

/** A new repo per run: the per-worker runtime dir can outlive a run. */
function freshRepo(name: string): string {
  fs.rmSync(createIsolatedGitRepo(name), { recursive: true, force: true })
  return createIsolatedGitRepo(name)
}

test.describe('Project General tab: git changes outside the app', () => {
  let repo = ''

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    repo = freshRepo('project-general-fs-watch')
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Watch General', color: '#22c55e', path: repo })
    await s.createTask({ projectId: p.id, title: 'PGW task', status: 'todo' })
    await s.refreshData()
    await goHome(mainWindow)
    await clickProject(mainWindow, p.name.slice(0, 2).toUpperCase())
    await expect(mainWindow.getByText('PGW task').first()).toBeVisible({ timeout: 5_000 })
  })

  test('a file edit shows in the status well before the next poll', async ({ mainWindow }) => {
    // 20s backoff wait + the change's budget.
    test.setTimeout(60_000)
    await homePanelBtn(mainWindow, 'Git').click()
    await expect(shown(mainWindow, 'Commits & Branches')).toBeVisible({ timeout: 10_000 })
    // The first read landed (Checking... is gone).
    await expect(shown(mainWindow, 'No changes')).toBeVisible({ timeout: 10_000 })

    // Let the poll back off: reads at +5s and +15s (unchanged), the next at +35s.
    await mainWindow.waitForTimeout(20_000)

    fs.writeFileSync(path.join(repo, 'edited-outside.txt'), 'hello\n')
    // Old build: nothing reads git until the +35s poll → this times out. New build:
    // the watcher's change event (200ms debounce) re-reads at once.
    await expect(shown(mainWindow, '1 untracked')).toBeVisible({ timeout: 8_000 })
  })
})
