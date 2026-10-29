import type { Page } from '@playwright/test'
import { test, expect, seed, openTaskById, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'

// The artifacts panel's selection save and viewer state.
// - The selection is saved (`active_artifact_id`) 500 ms after it is made. One still
//   waiting for that save when its task tab closed was dropped, so the panel reopened
//   on the previous artifact.
// - The viewer's view state (view mode, find bar) is reset when another artifact is
//   selected. Task tabs live in <Activity>, which re-runs effects on show, and the reset
//   was an effect: every tab show also closed an open find bar and put the saved /
//   default view mode back over the raw view a search hit opens. And it ran a commit
//   after a search hit in another artifact, so that hit opened the find bar without its
//   query, in the default (rich-text) view.

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
const rowButton = (page: Page, artifactId: string) =>
  panel(page).locator(`[data-testid="artifact-row-${artifactId}"] button`).first()
// TreeSidebar's row style for the current artifact.
const CURRENT = /(^|\s)border-primary\/40(\s|$)/
const findInput = (page: Page) => panel(page).getByPlaceholder('Find...')
/** A file's result group in the search sidebar: its header button + one per match line. */
const searchGroupButtons = (page: Page, title: string) =>
  panel(page).locator(
    `xpath=.//input[@placeholder="Search artifacts..."]/ancestor::div[3]/div[2]` +
      `/div[button/span[1][normalize-space(.)="${title}"]]/button`
  )

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

/** A markdown artifact in the raw view: CodeMirror, no rich-text (Milkdown) editor. */
async function expectRawView(page: Page): Promise<void> {
  await expect(panel(page).locator('.cm-editor').first()).toBeVisible({ timeout: 10_000 })
  await expect(panel(page).locator('.ProseMirror')).toHaveCount(0)
}

test.describe('Artifacts panel: selection saved on tab close, view state kept on tab show', () => {
  let taskA = ''
  let taskB = ''
  const ids: Record<'one' | 'two', string> = { one: '', two: '' }

  async function showA(page: Page): Promise<void> {
    await openTaskById(page, taskA)
    await expect(panel(page)).toBeVisible({ timeout: 10_000 })
  }

  /** Show B's tab: A's pane is hidden once this returns. */
  async function showB(page: Page): Promise<void> {
    await openTaskById(page, taskB)
    await expect(panel(page)).toHaveCount(0, { timeout: 10_000 })
  }

  /** Select an artifact in the Explorer tree; it is current once this returns. */
  async function selectInTree(page: Page, artifactId: string): Promise<void> {
    await rowButton(page, artifactId).click()
    await expect(rowButton(page, artifactId)).toHaveClass(CURRENT, { timeout: 10_000 })
  }

  const savedArtifactOfA = async (page: Page): Promise<string | null> => {
    const tasks = await seed(page).getTasks()
    return tasks.find((t) => t.id === taskA)?.active_artifact_id ?? null
  }

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Selection Close',
      color: '#f97316',
      path: TEST_PROJECT_PATH
    })
    taskA = (await s.createTask({ projectId: p.id, title: 'SC task A', status: 'todo' })).id
    taskB = (await s.createTask({ projectId: p.id, title: 'SC task B', status: 'todo' })).id
    for (const [key, content] of [
      ['one', 'needle one\n'],
      ['two', 'needle two\n']
    ] as const) {
      const artifact = await s.createArtifact({ taskId: taskA, title: `${key}.md`, content })
      if (!artifact) throw new Error(`seed returned no artifact ${key}.md`)
      ids[key] = artifact.id
    }
    await s.updateTask({
      id: taskA,
      panelVisibility: PANELS_WITH_ARTIFACTS,
      activeArtifactId: ids.one
    })
    await s.refreshData()
  })

  test('a selection made just before the task tab closes is saved, and the panel reopens on it', async ({
    mainWindow
  }) => {
    await showA(mainWindow)
    await expect(rowButton(mainWindow, ids.one)).toHaveClass(CURRENT, { timeout: 10_000 })
    expect(await savedArtifactOfA(mainWindow)).toBe(ids.one)

    // Click two.md, then close A's tab once the selection is on screen (its 500 ms
    // save scheduled) — in one page script, so the tab is gone well inside the window.
    const probe = await mainWindow.evaluate(
      async ({ a, two }) => {
        const w = window as unknown as {
          __slayzone_tabStore: { getState: () => { closeTabByTaskId: (id: string) => void } }
        }
        const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))
        const until = async (cond: () => boolean, what: string) => {
          for (let i = 0; i < 600 && !cond(); i++) await frame()
          if (!cond()) throw new Error(`timed out waiting for ${what}`)
        }
        const button = document.querySelector<HTMLElement>(
          `[data-testid="artifact-row-${two}"] button`
        )
        if (!button) throw new Error('two.md row missing')
        button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        const selectedAt = performance.now()
        await until(
          () => button.className.split(/\s+/).includes('border-primary/40'),
          'two.md current'
        )
        await frame() // the panel's selection-change effect has run: the save is scheduled
        w.__slayzone_tabStore.getState().closeTabByTaskId(a)
        await until(() => !button.isConnected, "A's tab to unmount")
        return { unmountMs: Math.round(performance.now() - selectedAt) }
      },
      { a: taskA, two: ids.two }
    )
    // Not asserted (wall clock): the old bug needs the unmount inside the 500 ms window.
    test.info().annotations.push({
      type: 'select-to-unmount ms',
      description: `+${probe.unmountMs}ms`
    })

    // The old build dropped the pending save at unmount: one.md stayed saved.
    await expect.poll(() => savedArtifactOfA(mainWindow), { timeout: 10_000 }).toBe(ids.two)
    // The page's task data has the save before the tab reopens (the panel takes it on mount).
    await seed(mainWindow).refreshData()
    await showA(mainWindow)
    await expect(rowButton(mainWindow, ids.two)).toHaveClass(CURRENT, { timeout: 10_000 })
  })

  test('an open find bar keeps its query across a tab switch', async ({ mainWindow }) => {
    await showA(mainWindow)
    await selectInTree(mainWindow, ids.one)
    // ⌘F, dispatched to the panel (an OS menu accelerator could take the real key).
    await rowButton(mainWindow, ids.one).dispatchEvent('keydown', { key: 'f', metaKey: true })
    await findInput(mainWindow).fill('needle')
    await expect(findInput(mainWindow)).toHaveValue('needle')

    await showB(mainWindow)
    await showA(mainWindow)
    await frames(mainWindow, 5)
    // The old build closed the find bar on show.
    await expect(findInput(mainWindow)).toBeVisible()
    await expect(findInput(mainWindow)).toHaveValue('needle')
  })

  test("a search hit in another artifact opens it raw, on the hit's query, and both stay on a tab switch", async ({
    mainWindow
  }) => {
    await showA(mainWindow)
    // Two selection changes close any find bar (each resets the view): one.md is current.
    await selectInTree(mainWindow, ids.two)
    await selectInTree(mainWindow, ids.one)
    await expect(findInput(mainWindow)).toHaveCount(0)

    // The sidebar's Explorer | Search mode toggle (the first search icon in the panel).
    await panel(mainWindow).locator('button:has(svg.lucide-search)').first().click()
    await panel(mainWindow).getByPlaceholder('Search artifacts...').fill('needle')
    await expect(panel(mainWindow).getByText('2 results in 2 files')).toBeVisible({
      timeout: 10_000
    })
    // two.md's first match line.
    await searchGroupButtons(mainWindow, 'two.md').nth(1).click()
    // The old build opened the find bar empty, in the rich-text view.
    await expect(findInput(mainWindow)).toHaveValue('needle', { timeout: 10_000 })
    await expectRawView(mainWindow)

    await showB(mainWindow)
    await showA(mainWindow)
    await frames(mainWindow, 5)
    await expect(findInput(mainWindow)).toHaveValue('needle')
    await expectRawView(mainWindow)
  })
})
