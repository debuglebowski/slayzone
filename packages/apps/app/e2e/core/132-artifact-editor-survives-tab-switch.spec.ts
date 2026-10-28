import type { Page } from '@playwright/test'
import { test, expect, seed, openTaskById, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'

// The artifact editor across a task-tab switch. Task tabs live in <Activity>, so a
// hidden tab's effects re-run when it is shown again. The load effect used to set
// "Loading..." on every run, and the CodeMirror view is rebuilt on every show: the
// caret went back to the start, and scroll and undo history were lost.

const PANELS_WITH_ARTIFACTS = {
  terminal: true,
  browser: false,
  diff: false,
  settings: true,
  editor: false,
  artifacts: true,
  processes: false
}

/** The task's artifacts panel; only task A has one, so it is A's when visible. */
const panel = (page: Page) => page.locator('[data-panel-id="artifacts"]:visible')
const editor = (page: Page) => panel(page).locator('.cm-editor').first()

const DOC = Array.from({ length: 300 }, (_, i) => `line${i + 1}`).join('\n') + '\n'
/** The artifact's text on disk (the editor autosaves 500 ms after an edit). */
const readDoc = (page: Page, id: string) =>
  page.evaluate(
    (artifactId) => window.getTrpcVanillaClient().artifacts.readContent.query({ id: artifactId }),
    id
  )

/** Resolve after `n` painted frames. */
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

test.describe('Artifact editor across a tab switch', () => {
  let taskA = ''
  let taskB = ''
  let artifactId = ''

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Editor Switch',
      color: '#22c55e',
      path: TEST_PROJECT_PATH
    })
    taskA = (await s.createTask({ projectId: p.id, title: 'ES task A', status: 'todo' })).id
    taskB = (await s.createTask({ projectId: p.id, title: 'ES task B', status: 'todo' })).id
    // A code extension, so CodeMirror renders directly.
    const artifact = await s.createArtifact({
      taskId: taskA,
      title: 'caret.ts',
      content: DOC
    })
    if (!artifact) throw new Error('seed returned no artifact caret.ts')
    artifactId = artifact.id
    await s.updateTask({
      id: taskA,
      panelVisibility: PANELS_WITH_ARTIFACTS,
      activeArtifactId: artifact.id
    })
    await s.refreshData()
  })

  test('showing the tab keeps the caret, scroll and undo, with no Loading flash', async ({
    mainWindow
  }) => {
    await openTaskById(mainWindow, taskA)
    await expect(editor(mainWindow)).toBeVisible({ timeout: 10_000 })
    const content = editor(mainWindow).locator('.cm-content')
    const scroller = editor(mainWindow).locator('.cm-scroller')
    await content.click()
    // An edit (for undo), then the caret to the end of line 150, scrolled into view.
    await mainWindow.keyboard.press('Meta+ArrowUp')
    await mainWindow.keyboard.type('U')
    await mainWindow.keyboard.press('Meta+ArrowUp')
    for (let i = 0; i < 149; i++) await mainWindow.keyboard.press('ArrowDown')
    await mainWindow.keyboard.press('End')
    await frames(mainWindow, 5)
    const scrollBefore = await scroller.evaluate((el) => el.scrollTop)
    expect(scrollBefore, 'caret line scrolled into view').toBeGreaterThan(500)

    // Record any "Loading..." in A's artifact pane while it is shown again.
    await mainWindow.evaluate(() => {
      const w = window as unknown as { __loadingSeen: boolean }
      w.__loadingSeen = false
      new MutationObserver(() => {
        const p = document.querySelector('[data-panel-id="artifacts"]')
        if (p?.textContent?.includes('Loading...')) w.__loadingSeen = true
      }).observe(document.body, { childList: true, subtree: true, characterData: true })
    })

    await openTaskById(mainWindow, taskB)
    await expect(panel(mainWindow)).toHaveCount(0, { timeout: 10_000 })
    await openTaskById(mainWindow, taskA)
    await expect(editor(mainWindow)).toBeVisible({ timeout: 10_000 })
    // The reload on show (one disk read) has landed well inside this.
    await frames(mainWindow, 30)

    expect(
      await mainWindow.evaluate(
        () => (window as unknown as { __loadingSeen: boolean }).__loadingSeen
      ),
      'Loading... shown on tab show'
    ).toBe(false)
    expect(await scroller.evaluate((el) => el.scrollTop), 'scroll kept').toBe(scrollBefore)

    // Focus without clicking: CodeMirror keeps its own selection.
    await content.focus()
    await mainWindow.keyboard.type('X')
    await expect
      .poll(() => readDoc(mainWindow, artifactId), { timeout: 3_000 })
      .toMatch(/^Uline1\n[\s\S]*\nline150X\n/)
    // Undo history kept: two undos remove the X, then the U.
    await mainWindow.keyboard.press('Meta+z')
    await mainWindow.keyboard.press('Meta+z')
    await expect.poll(() => readDoc(mainWindow, artifactId), { timeout: 3_000 }).toBe(DOC)
  })
})
