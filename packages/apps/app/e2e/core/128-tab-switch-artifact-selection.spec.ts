import type { Page } from '@playwright/test'
import { test, expect, seed, openTaskById, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'

// The artifacts panel across a task-tab switch. Task tabs live in <Activity>, so a
// hidden tab's effects re-run when it is shown again. Two resets rode on that:
// - the selection was set back to the task's saved artifact (`active_artifact_id`),
//   which trails a selection by its 500 ms debounced save: select, switch away and
//   back inside that window, and the previous artifact came back (collapsing a
//   multi-select), and was then saved over the new one;
// - the search re-runs on show, and every finished run expanded all result groups,
//   so groups collapsed by hand opened again.

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
// TreeSidebar's row styles: the current artifact, and the others in a multi-select.
const CURRENT = /(^|\s)border-primary\/40(\s|$)/
const MULTI = /(^|\s)border-primary\/30(\s|$)/
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

test.describe('Artifacts panel across a tab switch', () => {
  let taskA = ''
  let taskB = ''
  const ids: Record<'one' | 'two' | 'three', string> = { one: '', two: '', three: '' }

  async function showA(page: Page): Promise<void> {
    await openTaskById(page, taskA)
    await expect(panel(page)).toBeVisible({ timeout: 10_000 })
  }

  /** Show B's tab: A's pane is hidden once this returns. */
  async function showB(page: Page): Promise<void> {
    await openTaskById(page, taskB)
    await expect(panel(page)).toHaveCount(0, { timeout: 10_000 })
  }

  const savedArtifactOfA = async (page: Page): Promise<string | null> => {
    const tasks = await seed(page).getTasks()
    return tasks.find((t) => t.id === taskA)?.active_artifact_id ?? null
  }

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Selection Switch',
      color: '#0ea5e9',
      path: TEST_PROJECT_PATH
    })
    taskA = (await s.createTask({ projectId: p.id, title: 'SS task A', status: 'todo' })).id
    taskB = (await s.createTask({ projectId: p.id, title: 'SS task B', status: 'todo' })).id
    for (const [key, content] of [
      ['one', 'needle one\n'],
      ['two', 'needle two\n'],
      ['three', 'plain\n']
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

  test('a selection made just before a tab switch stays, multi-select and all, and is saved', async ({
    mainWindow
  }) => {
    // Both tabs open, so the timed switch below is two tab activations, no mounts.
    await showA(mainWindow)
    await showB(mainWindow)
    await showA(mainWindow)
    await expect(rowButton(mainWindow, ids.one)).toHaveClass(CURRENT, { timeout: 10_000 })
    expect(await savedArtifactOfA(mainWindow)).toBe(ids.one)

    // Click two.md, ⌘-click three.md, then hide A behind B and show it again — in one
    // page script, so it all lands well inside the 500 ms save window. Records whether
    // one.md is ever current again, even for a single frame, and what A had saved
    // right after it was shown.
    const probe = await mainWindow.evaluate(
      async ({ a, b, one, two, three }) => {
        const w = window as unknown as {
          __slayzone_openTask: (id: string) => void
          __oneCurrentAgain: boolean
        }
        const button = (id: string) =>
          document.querySelector<HTMLElement>(`[data-testid="artifact-row-${id}"] button`)
        const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))
        const until = async (cond: () => boolean, what: string) => {
          for (let i = 0; i < 600 && !cond(); i++) await frame()
          if (!cond()) throw new Error(`timed out waiting for ${what}`)
        }
        const oneButton = button(one)
        const twoButton = button(two)
        const threeButton = button(three)
        if (!oneButton || !twoButton || !threeButton) throw new Error('artifact rows missing')
        // A hidden tab keeps its layout and hides with visibility:hidden (TabPanes),
        // which checkVisibility() and the box do not see. The artifacts panel's own
        // <Activity> sets display:none, which checkVisibility() does: that is the
        // signal that the panel's effects were torn down (and re-run when shown).
        const activityHidden = () => !oneButton.checkVisibility()
        const tabShown = () =>
          oneButton.checkVisibility() && getComputedStyle(oneButton).visibility === 'visible'
        if (!tabShown()) throw new Error('task A is not on screen')

        w.__oneCurrentAgain = false
        new MutationObserver(() => {
          if (oneButton.className.split(/\s+/).includes('border-primary/40'))
            w.__oneCurrentAgain = true
        }).observe(oneButton, { attributes: true, attributeFilter: ['class'] })

        const click = (el: HTMLElement, metaKey: boolean) =>
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey }))
        click(twoButton, false)
        click(threeButton, true) // the last selection: its 500 ms save starts here
        const selectedAt = performance.now()
        w.__slayzone_openTask(b)
        await until(activityHidden, "A's artifacts panel to be hidden")
        const hiddenAt = performance.now()
        w.__slayzone_openTask(a)
        await until(tabShown, 'task A to be shown again')
        const shownAt = performance.now()
        const savedAtShow = await window
          .getTrpcVanillaClient()
          .task.get.query({ id: a })
          .then((t) => t?.active_artifact_id ?? null)
        return {
          hideMs: Math.round(hiddenAt - selectedAt),
          showMs: Math.round(shownAt - selectedAt),
          savedAtShow
        }
      },
      { a: taskA, b: taskB, one: ids.one, two: ids.two, three: ids.three }
    )
    // Not asserted (wall clock): what the switch took, from the last click.
    test.info().annotations.push({
      type: 'select-and-switch ms',
      description: `hidden +${probe.hideMs}ms, shown again +${probe.showMs}ms`
    })
    // Shown again before three.md's save landed: A's saved artifact was still one.md,
    // which is the window the old bug needs (it put one.md back on show).
    expect(probe.savedAtShow, 'shown again inside the 500 ms save window').toBe(ids.one)
    await frames(mainWindow, 5)

    await expect(rowButton(mainWindow, ids.three)).toHaveClass(CURRENT)
    await expect(rowButton(mainWindow, ids.two)).toHaveClass(MULTI)
    await expect(rowButton(mainWindow, ids.one)).not.toHaveClass(CURRENT)
    await expect(rowButton(mainWindow, ids.one)).not.toHaveClass(MULTI)
    expect(
      await mainWindow.evaluate(
        () => (window as unknown as { __oneCurrentAgain: boolean }).__oneCurrentAgain
      )
    ).toBe(false)
    // The selection made before the switch is the one saved (the old bug saved one.md
    // back over it).
    await expect.poll(() => savedArtifactOfA(mainWindow), { timeout: 10_000 }).toBe(ids.three)
  })

  test('result groups collapsed in search stay collapsed when the tab is shown again', async ({
    mainWindow
  }) => {
    await showA(mainWindow)
    // The sidebar's Explorer | Search mode toggle (the first search icon in the panel).
    await panel(mainWindow).locator('button:has(svg.lucide-search)').first().click()
    await panel(mainWindow).getByPlaceholder('Search artifacts...').fill('needle')
    await expect(panel(mainWindow).getByText('2 results in 2 files')).toBeVisible({
      timeout: 10_000
    })
    await expect(searchGroupButtons(mainWindow, 'one.md')).toHaveCount(2)
    await searchGroupButtons(mainWindow, 'one.md').first().click()
    await expect(searchGroupButtons(mainWindow, 'one.md')).toHaveCount(1)

    // While A is hidden its artifact list changes, so the search that re-runs on show
    // lands with a new file: proof the re-run finished before the check below.
    await showB(mainWindow)
    const s = seed(mainWindow)
    await s.createArtifact({ taskId: taskA, title: 'four.md', content: 'needle four\n' })
    await s.refreshData()
    await showA(mainWindow)

    await expect(panel(mainWindow).getByText('3 results in 3 files')).toBeVisible({
      timeout: 10_000
    })
    await expect(searchGroupButtons(mainWindow, 'one.md')).toHaveCount(1)
    await expect(searchGroupButtons(mainWindow, 'two.md')).toHaveCount(2)
    await expect(searchGroupButtons(mainWindow, 'four.md')).toHaveCount(2)
  })
})
