import type { Page } from '@playwright/test'
import { test, expect, seed, openTaskById, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'

// An artifact renamed in the panel keeps its new name across a task-tab switch.
// Task tabs live in <Activity>, so a hidden tab's effects re-run when it is shown
// again; the query→local mirror used to re-run with it and put the older cached
// list (pre-rename title) back on screen.

const PANELS_WITH_ARTIFACTS = {
  terminal: true,
  browser: false,
  diff: false,
  settings: true,
  editor: false,
  artifacts: true,
  processes: false
}

const OLD_TITLE = 'before-switch.md'
const NEW_TITLE = 'after-switch.md'

const sidebar = (page: Page) =>
  page.locator('[data-panel-id="artifacts"]:visible [data-testid="artifacts-sidebar"]')
const artifactRow = (page: Page, title: string) =>
  sidebar(page)
    .locator('[data-testid^="artifact-row-"]')
    .locator('button')
    .filter({ has: page.locator('span', { hasText: title }) })
    .first()

/** From now on, record whether any artifact row ever shows `title`. */
async function watchForTitle(page: Page, title: string): Promise<void> {
  await page.evaluate((t) => {
    const w = window as unknown as { __oldTitleSeen: boolean; __oldTitleStop?: () => void }
    w.__oldTitleStop?.()
    w.__oldTitleSeen = false
    const check = (): void => {
      for (const row of document.querySelectorAll('[data-testid^="artifact-row-"]')) {
        if (row.textContent?.includes(t)) w.__oldTitleSeen = true
      }
    }
    const observer = new MutationObserver(check)
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    w.__oldTitleStop = () => observer.disconnect()
  }, title)
}

const titleSeen = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __oldTitleSeen: boolean; __oldTitleStop?: () => void }
    w.__oldTitleStop?.()
    return w.__oldTitleSeen
  })

/** Resolve after `n` painted frames: every commit queued by the re-show has landed. */
const frames = (page: Page, n: number) =>
  page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        let left = count
        const tick = (): void => {
          if (--left <= 0) resolve()
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
    n
  )

test.describe('Artifact rename across a tab switch', () => {
  let taskA = ''
  let taskB = ''

  // Only A shows the artifacts panel, so its visibility pins which task's pane is on
  // screen. `openTaskById` alone can return while the previous tab is still visible.
  async function showA(page: Page): Promise<void> {
    await openTaskById(page, taskA)
    await expect(sidebar(page)).toBeVisible({ timeout: 10_000 })
  }

  /** Show B's tab: A's pane is hidden once this returns. */
  async function showB(page: Page): Promise<void> {
    await openTaskById(page, taskB)
    await expect(sidebar(page)).toHaveCount(0, { timeout: 10_000 })
  }

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Rename Switch',
      color: '#eab308',
      path: TEST_PROJECT_PATH
    })
    taskA = (await s.createTask({ projectId: p.id, title: 'RS task A', status: 'todo' })).id
    taskB = (await s.createTask({ projectId: p.id, title: 'RS task B', status: 'todo' })).id
    await s.updateTask({ id: taskA, panelVisibility: PANELS_WITH_ARTIFACTS })
    await s.createArtifact({ taskId: taskA, title: OLD_TITLE, content: '# hi\n' })
    await s.refreshData()
  })

  test('a just-renamed artifact keeps its new name when the tab is shown again', async ({
    mainWindow
  }) => {
    await showA(mainWindow)
    await expect(artifactRow(mainWindow, OLD_TITLE)).toBeVisible({ timeout: 10_000 })

    await artifactRow(mainWindow, OLD_TITLE).click({ button: 'right' })
    await mainWindow.getByRole('menuitem', { name: 'Rename' }).click()
    const input = sidebar(mainWindow).getByTestId('artifacts-rename-input')
    await expect(input).toBeVisible()
    await input.fill(NEW_TITLE)
    await input.press('Enter')
    await expect(artifactRow(mainWindow, NEW_TITLE)).toBeVisible()
    await expect(artifactRow(mainWindow, OLD_TITLE)).toHaveCount(0)

    // Hide and re-show A while its artifacts query cache is still fresh (<5s).
    await showB(mainWindow)
    await watchForTitle(mainWindow, OLD_TITLE)
    await showA(mainWindow)
    await frames(mainWindow, 5)

    await expect(artifactRow(mainWindow, NEW_TITLE)).toBeVisible()
    await expect(artifactRow(mainWindow, OLD_TITLE)).toHaveCount(0)
    expect(await titleSeen(mainWindow)).toBe(false)
  })
})
