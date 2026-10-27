import type { Page } from '@playwright/test'
import { MODAL_DIALOG_SELECTOR } from '@slayzone/ui/is-modal-dialog-open'
import { test, expect, seed, openTaskById, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'

// Switching task tabs must cost the same with 3 tabs open as with 30. Every open tab
// stays mounted (hidden), so anything that re-renders ALL tabs on a switch — an
// unstable callback prop defeating TaskDetailDataLoader's memo, an uncompiled parent
// re-creating closures — makes the switch O(open tabs). Measured on a 50-tab dev
// session: ~51k component renders and 1.1–3s per switch, ~105ms per keystroke.
//
// Counted, not timed: a render count is deterministic under load, a millisecond
// budget is not. React reports each commit to a DevTools global hook (production
// builds included), installed here before React boots.

type ProbeWindow = Window & {
  __szRenderProbe: {
    on: boolean
    renders: number
    commits: number
    byName: Record<string, number>
  }
  __slayzone_tabStore: {
    getState: () => {
      tabs: Array<{ type: string; taskId?: string }>
      openTask: (taskId: string) => void
      openTaskInBackground: (taskId: string) => void
    }
  }
}

/**
 * Counts component renders per commit. A composite fiber rendered this commit when it
 * is new or carries PerformedWork; a subtree whose child list is the alternate's own
 * (bailed out with no pending work) was not visited by React, so it is skipped — its
 * flags are stale from an earlier commit.
 */
function installRenderProbe(): void {
  const probe = { on: false, renders: 0, commits: 0, byName: {} as Record<string, number> }
  ;(window as unknown as { __szRenderProbe: typeof probe }).__szRenderProbe = probe
  const PERFORMED_WORK = 1
  // FunctionComponent, ClassComponent, ForwardRef, MemoComponent, SimpleMemoComponent
  const COMPOSITE = new Set([0, 1, 11, 14, 15])
  type ComponentType = {
    displayName?: string
    name?: string
    render?: ComponentType
    type?: ComponentType
  }
  type Fiber = {
    tag: number
    flags: number
    type: ComponentType | null
    child: Fiber | null
    sibling: Fiber | null
    alternate: Fiber | null
  }
  const nameOf = (t: ComponentType | null): string =>
    t?.displayName ||
    t?.name ||
    t?.render?.displayName ||
    t?.render?.name ||
    t?.type?.displayName ||
    t?.type?.name ||
    '(anonymous)'
  const renderers = new Map<number, unknown>()
  ;(
    window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown }
  ).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers,
    inject(renderer: unknown) {
      const id = renderers.size + 1
      renderers.set(id, renderer)
      return id
    },
    checkDCE() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id: number, root: { current: Fiber }) {
      if (!probe.on) return
      probe.commits++
      const stack: Fiber[] = [root.current]
      while (stack.length > 0) {
        const f = stack.pop()!
        if (f.sibling) stack.push(f.sibling)
        const fresh = f.alternate === null
        if (COMPOSITE.has(f.tag) && (fresh || (f.flags & PERFORMED_WORK) !== 0)) {
          probe.renders++
          const name = nameOf(f.type)
          probe.byName[name] = (probe.byName[name] ?? 0) + 1
        }
        if (f.child && (fresh || f.child !== f.alternate!.child)) stack.push(f.child)
      }
    }
  }
}

/**
 * Activate each task in turn; returns the median component renders per switch and
 * the components that rendered most across all of them (for the failure message).
 */
async function rendersPerSwitch(
  page: Page,
  taskIds: string[]
): Promise<{
  median: number
  top: string
  perSwitch: (name: string) => number
}> {
  const { counts, byName } = await page.evaluate(async (ids) => {
    const w = window as unknown as ProbeWindow
    const probe = w.__szRenderProbe
    // A switch is done when React has committed nothing for a while (the deferred
    // content render and its effects land after the first commit).
    const settle = async (): Promise<void> => {
      let last = -1
      for (let i = 0; i < 40 && last !== probe.commits; i++) {
        last = probe.commits
        await new Promise((r) => setTimeout(r, 150))
      }
    }
    const out: number[] = []
    probe.byName = {}
    for (const id of ids) {
      await settle()
      probe.renders = 0
      probe.on = true
      w.__slayzone_tabStore.getState().openTask(id)
      await settle()
      probe.on = false
      out.push(probe.renders)
    }
    return { counts: out, byName: probe.byName }
  }, taskIds)
  const sorted = [...counts].sort((a, b) => a - b)
  const top = Object.entries(byName)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([name, n]) => `${name} ${Math.round(n / counts.length)}`)
    .join(', ')
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    top,
    perSwitch: (name) => (byName[name] ?? 0) / counts.length
  }
}

/** Open every task (hidden, in the background) and wait until each tab's detail page is mounted. */
async function openAllInBackground(page: Page, ids: string[]): Promise<void> {
  await page.evaluate((all) => {
    const s = (window as unknown as ProbeWindow).__slayzone_tabStore.getState()
    for (const id of all) s.openTaskInBackground(id)
  }, ids)
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as unknown as ProbeWindow).__slayzone_tabStore
              .getState()
              .tabs.filter((t) => t.type === 'task').length
        ),
      { timeout: 10_000 }
    )
    .toBe(ids.length)
  // Every background tab mounts its detail page (hidden) — wait until each has one.
  await expect
    .poll(() => page.locator('[data-testid="terminal-mode-trigger"]').count(), {
      timeout: 60_000,
      intervals: [500, 1_000]
    })
    .toBeGreaterThanOrEqual(ids.length)
}

test.describe('Tab switch cost does not scale with open tabs', () => {
  const TOTAL = 30
  let taskIds: string[] = []

  test.beforeAll(async ({ mainWindow }) => {
    await mainWindow.addInitScript(installRenderProbe)
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Switch Scaling',
      color: '#0ea5e9',
      path: TEST_PROJECT_PATH
    })
    taskIds = []
    for (let i = 0; i < TOTAL; i++) {
      const t = await s.createTask({
        projectId: p.id,
        title: `Scaling task ${i}`,
        status: 'in_progress',
        terminalMode: 'terminal'
      })
      taskIds.push(t.id)
    }
    await s.refreshData()
  })

  test('a switch re-renders the same amount with 3 or 30 tabs open', async ({ mainWindow }) => {
    test.setTimeout(120_000)
    const probeInstalled = await mainWindow.evaluate(
      () => typeof (window as unknown as ProbeWindow).__szRenderProbe === 'object'
    )
    expect(probeInstalled).toBe(true)

    const switching = taskIds.slice(0, 3)
    for (const id of switching) await openTaskById(mainWindow, id)
    const cycle = [...switching, ...switching, ...switching]
    await rendersPerSwitch(mainWindow, cycle) // warm: lazy panels, first-activation effects
    const { median: few, top: fewTop } = await rendersPerSwitch(mainWindow, cycle)
    expect(few).toBeGreaterThan(0)

    await openAllInBackground(mainWindow, taskIds)

    await rendersPerSwitch(mainWindow, cycle)
    const { median: many, top: manyTop } = await rendersPerSwitch(mainWindow, cycle)

    const summary =
      `renders per switch: ${few} with 3 tabs, ${many} with ${TOTAL}\n` +
      `  3 tabs, most rendered: ${fewTop}\n` +
      `  ${TOTAL} tabs, most rendered: ${manyTop}`
    test.info().annotations.push({ type: 'renders', description: summary })
    console.log(summary)
    // 10× the tabs must not mean (meaningfully) more renders per switch. Before the
    // fix every hidden tab re-rendered: 14.5k renders with 3 tabs, 40.5k with 30.
    expect(many, summary).toBeLessThan(few * 1.5)
  })

  test('a switch between tabs of one project does not re-render the app shell', async ({
    mainWindow
  }) => {
    // App owns the whole shell (sidebar, tab bar, dialogs, side panels). When it
    // subscribed to the active tab index, every switch re-ran it and its uncompiled
    // hooks, rebuilding the tab bar's callbacks and right-hand content. Only the
    // components that show which tab is active may render on a switch.
    test.setTimeout(120_000)
    const switching = taskIds.slice(0, 3)
    for (const id of switching) await openTaskById(mainWindow, id)
    const cycle = [...switching, ...switching, ...switching]
    await rendersPerSwitch(mainWindow, cycle)
    const { perSwitch, top } = await rendersPerSwitch(mainWindow, cycle)
    expect(perSwitch('App'), top).toBe(0)
    // The tab bar re-renders once (new active index); its tooltips and header
    // actions do not.
    expect(perSwitch('TabBar'), top).toBeLessThanOrEqual(1)
    expect(perSwitch('AppHeaderActions'), top).toBe(0)
  })

  test("revealing a tab mounts none of its closed selects' options", async ({ mainWindow }) => {
    // The incoming tab's panels sit in <Activity mode="hidden"> until revealed. Each
    // closed Radix Select kept every option mounted, and a reveal re-ran their
    // ref/layout effects and remounted them all: ~680 of ~1,470 renders per switch
    // came from the settings panel's four selects alone.
    test.setTimeout(120_000)
    const switching = taskIds.slice(0, 3)
    for (const id of switching) await openTaskById(mainWindow, id)
    const cycle = [...switching, ...switching, ...switching]
    await rendersPerSwitch(mainWindow, cycle)
    const { median, top, perSwitch } = await rendersPerSwitch(mainWindow, cycle)
    const summary = `renders per switch: ${median}\n  most rendered: ${top}`
    test.info().annotations.push({ type: 'renders', description: summary })
    console.log(summary)
    // SelectItemText only exists inside a mounted Radix option (our closed-select
    // wrapper is also named SelectItem, and renders nothing).
    expect(perSwitch('SelectItemText'), summary).toBe(0)
    // Once, for the reveal itself — its effects (re-run by the reveal) must not render it again.
    expect(perSwitch('TaskSettingsPanel'), summary).toBeLessThanOrEqual(1)
  })

  test('a keystroke checks for an open modal exactly once', async ({ mainWindow }) => {
    // Every guarded keydown handler used to run its own full-document query for an
    // open modal — 2 per open tab, each ~1ms on a large DOM. Counted by the guard's own
    // selector, under either query API, so a selector or API change cannot zero it out.
    test.setTimeout(120_000)
    await openTaskById(mainWindow, taskIds[0])
    await openAllInBackground(mainWindow, taskIds)
    const modalQueries = await mainWindow.evaluate((modalSelector) => {
      const proto = Document.prototype
      const { querySelector, querySelectorAll } = proto
      let n = 0
      proto.querySelector = function (this: Document, selectors: string) {
        if (selectors === modalSelector) n++
        return querySelector.call(this, selectors)
      } as typeof proto.querySelector
      proto.querySelectorAll = function (this: Document, selectors: string) {
        if (selectors === modalSelector) n++
        return querySelectorAll.call(this, selectors)
      } as typeof proto.querySelectorAll
      try {
        document.body.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'F19', code: 'F19', bubbles: true, cancelable: true })
        )
      } finally {
        proto.querySelector = querySelector
        proto.querySelectorAll = querySelectorAll
      }
      return n
    }, MODAL_DIALOG_SELECTOR)
    // Exactly one: the shortcut dispatcher checks every keystroke, all later handlers
    // reuse its answer. Zero would mean the probe no longer sees the guard's query.
    expect(modalQueries).toBe(1)
  })
})
