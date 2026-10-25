import {
  test,
  expect,
  seed,
  openTaskById,
  resetApp,
  clickProject,
  TEST_PROJECT_PATH
} from '../fixtures/electron'
import { pressShortcut } from '../fixtures/shortcuts'

// Cmd+Shift+N (new temporary task) must not do work per open tab. With 30 task tabs
// open, one press re-rendered every hidden task page, its data loader and settings
// panel, and every board card — ~36k component renders, the main thread busy for
// ~600ms while the user waited to type. Causes, each fixed:
// - every page listened for focus on the WINDOW, so the new terminal taking focus
//   updated state in all 30 pages;
// - the task-detail cache had ONE version for all entries, so the new task's data
//   landing re-rendered every tab's loader;
// - a board row patch marked the wrong object as "our patch" (react-query's
//   structural sharing stores a different one), so the task list was rebuilt with a
//   new object for every task;
// - board card handlers were rebuilt on every render.
// Counted, not timed (see 111-tab-switch-scaling for the probe's method).

type Probe = {
  on: boolean
  renders: number
  commits: number
  byName: Record<string, number>
  /** `Component [why]` for components that rendered although their parent did not
   *  (where the work starts) — the failure message's diagnosis. */
  roots: Record<string, number>
}
type ProbeWindow = Window & { __szRenderProbe: Probe }

function installRenderProbe(): void {
  const probe: Probe = { on: false, renders: 0, commits: 0, byName: {}, roots: {} }
  ;(window as unknown as { __szRenderProbe: Probe }).__szRenderProbe = probe
  const PERFORMED_WORK = 1
  // FunctionComponent, ClassComponent, ForwardRef, MemoComponent, SimpleMemoComponent
  const COMPOSITE = new Set([0, 1, 11, 14, 15])
  type ComponentType = {
    displayName?: string
    name?: string
    render?: ComponentType
    type?: ComponentType
  }
  type Hook = { memoizedState: unknown; next: Hook | null } | null
  type Fiber = {
    tag: number
    flags: number
    type: ComponentType | null
    child: Fiber | null
    sibling: Fiber | null
    alternate: Fiber | null
    memoizedProps: Record<string, unknown> | null
    memoizedState: Hook
  }
  const nameOf = (t: ComponentType | null): string =>
    t?.displayName ||
    t?.name ||
    t?.render?.displayName ||
    t?.render?.name ||
    t?.type?.displayName ||
    t?.type?.name ||
    '(anonymous)'
  // Changed prop names, else the first changed state hook (effects allocate a new
  // hook object every render, so they are skipped), else context.
  const why = (f: Fiber): string => {
    const a = f.alternate
    if (!a) return 'mount'
    const p = f.memoizedProps ?? {}
    const q = a.memoizedProps ?? {}
    const changed = Object.keys({ ...p, ...q }).filter((k) => k !== 'children' && p[k] !== q[k])
    if (changed.length > 0) return `props:${changed.slice(0, 4).join(',')}`
    let h: Hook = f.memoizedState
    let g: Hook = a.memoizedState
    for (let i = 0; h && g; i++, h = h.next, g = g.next) {
      const v = h.memoizedState
      const isEffect = !!v && typeof v === 'object' && 'create' in v && 'deps' in v
      if (v !== g.memoizedState && !isEffect) return `state#${i}`
    }
    return p.children !== q.children ? 'props:children' : 'context'
  }
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
      // [fiber, did its nearest composite ancestor render]
      const stack: Array<[Fiber, boolean]> = [[root.current, false]]
      while (stack.length > 0) {
        const [f, parentRendered] = stack.pop()!
        if (f.sibling) stack.push([f.sibling, parentRendered])
        const fresh = f.alternate === null
        let rendered = parentRendered
        if (COMPOSITE.has(f.tag)) {
          rendered = fresh || (f.flags & PERFORMED_WORK) !== 0
          if (rendered) {
            probe.renders++
            const name = nameOf(f.type)
            probe.byName[name] = (probe.byName[name] ?? 0) + 1
            if (!parentRendered) {
              const key = `${name} [${why(f)}]`
              probe.roots[key] = (probe.roots[key] ?? 0) + 1
            }
          }
        }
        if (f.child && (fresh || f.child !== f.alternate!.child)) stack.push([f.child, rendered])
      }
    }
  }
}

test.describe('New temporary task render cost', () => {
  const TOTAL = 30
  let taskIds: string[] = []

  test.beforeAll(async ({ mainWindow }) => {
    await mainWindow.addInitScript(installRenderProbe)
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Temp Cost',
      color: '#0ea5e9',
      path: TEST_PROJECT_PATH
    })
    taskIds = []
    for (let i = 0; i < TOTAL; i++) {
      const t = await s.createTask({
        projectId: p.id,
        title: `Cost task ${i}`,
        status: 'in_progress',
        terminalMode: 'terminal'
      })
      taskIds.push(t.id)
    }
    await s.refreshData()
    await clickProject(mainWindow, 'TE')
  })

  test('a new temp task re-renders no hidden tab and no board card', async ({ mainWindow }) => {
    test.setTimeout(180_000)
    for (const id of taskIds) await openTaskById(mainWindow, id)
    await expect
      .poll(() => mainWindow.locator('[data-testid="terminal-mode-trigger"]').count(), {
        timeout: 90_000,
        intervals: [500, 1_000]
      })
      .toBeGreaterThanOrEqual(TOTAL)

    const measure = async (): Promise<Probe> => {
      await mainWindow.evaluate(async () => {
        const probe = (window as unknown as ProbeWindow).__szRenderProbe
        let last = -1
        for (let i = 0; i < 40 && last !== probe.commits; i++) {
          last = probe.commits
          await new Promise((r) => setTimeout(r, 150))
        }
        probe.renders = 0
        probe.commits = 0
        probe.byName = {}
        probe.roots = {}
        probe.on = true
      })
      await pressShortcut(mainWindow, 'new-temp-task')
      return mainWindow.evaluate(async () => {
        const probe = (window as unknown as ProbeWindow).__szRenderProbe
        await new Promise((r) => setTimeout(r, 300))
        let last = -1
        for (let i = 0; i < 40 && last !== probe.commits; i++) {
          last = probe.commits
          await new Promise((r) => setTimeout(r, 250))
        }
        probe.on = false
        return JSON.parse(JSON.stringify(probe)) as Probe
      })
    }
    await measure() // warm: lazy chunks, first temp-task mount paths
    const r = await measure()

    const top = (m: Record<string, number>, n: number): string =>
      Object.entries(m)
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([k, v]) => `  ${v}  ${k}`)
        .join('\n')
    const summary =
      `renders ${r.renders} in ${r.commits} commits\n` +
      `most rendered:\n${top(r.byName, 20)}\n` +
      `where work starts (component [why]):\n${top(r.roots, 25)}`
    test.info().annotations.push({ type: 'renders', description: summary })
    console.log(summary)

    expect(r.renders, summary).toBeGreaterThan(0)
    // Each of these rendered once or more PER OPEN TAB (or per card) before: any
    // count reaching the tab count means per-tab work is back. The new tab's own page
    // renders a few times as it mounts and takes over from its terminal-first pane.
    for (const name of [
      'TaskPane2',
      'TaskDetailDataLoader2',
      'TaskDetailPage2',
      'TaskSettingsPanel',
      'TaskMetadataSidebar',
      'KanbanCard'
    ]) {
      expect(r.byName[name] ?? 0, `${name}\n${summary}`).toBeLessThan(TOTAL)
    }
  })
})
