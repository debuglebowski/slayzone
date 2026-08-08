import {
  test,
  expect,
  seed,
  resetApp,
  goHome,
  showProjectBoard,
  TEST_PROJECT_PATH
} from '../fixtures/electron'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RESULTS_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'working-notes',
  'performance'
)

interface PerfMetrics {
  timestamp: string
  startup: { rootReadyMs?: number }
  memory: { usedMB: number; totalMB: number; limitMB: number }
  dom: {
    totalNodes: number
    divs: number
    svgs: number
    svgChildren: number
    svgPctOfDOM: number
    canvases: number
    styleElements: number
  }
  paint: { firstPaint: number; firstContentfulPaint: number }
  resources: { count: number; slowest: Array<{ name: string; durationMs: number }> }
  ipc: {
    loadBoardDataMs: number
    createTaskMs: number
    getProjectsMs: number
  }
  interaction: {
    tabSwitchMs: number
    taskOpenMs: number
    refreshDataMs: number
  }
  scaling: {
    taskCount: number
    domNodesAtScale: number
    memoryAtScaleMB: number
    loadBoardDataAtScaleMs: number
  }
}

function writePerfResults(name: string, data: unknown) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true })
  const filePath = path.join(RESULTS_DIR, `${name}.json`)
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
}

test.describe('Performance Profiling', () => {
  const metrics: Partial<PerfMetrics> = { timestamp: new Date().toISOString() }
  let projectId: string
  /**
   * DERIVED, not hardcoded. The sidebar renders a project's badge as
   * `name.slice(0, 2).toUpperCase()` (`ProjectAvatar.tsx`), so `PerfTest` is
   * **PE** — this was pinned to `'PF'`, which matches no button at all.
   *
   * `clickProject` therefore exhausted all 8 attempts looking for a badge that
   * could never exist and fell through to its last-resort fallback: type the
   * string into the command palette and press Enter, accepting whatever ranks
   * first among files, folders, commands, projects and tasks. That path lands on
   * the right project most of the time and silently navigates somewhere else the
   * rest of the time, at which point `Perf task 0` never appears and the whole
   * `beforeAll` fails — taking all ten tests with it and reporting under
   * `01 — memory baseline`, which is innocent.
   *
   * Measured before this change: 1 failure in 5 separate runs, matching 2/10 in
   * the full-suite campaign.
   */
  let projAbbrev: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'PerfTest', color: '#8b5cf6', path: TEST_PROJECT_PATH })
    projectId = p.id
    projAbbrev = p.name.slice(0, 2).toUpperCase()
    // Seed 10 tasks across statuses
    for (let i = 0; i < 10; i++) {
      const statuses = ['inbox', 'in_progress', 'done', 'in_progress', 'inbox']
      await s.createTask({ projectId, title: `Perf task ${i}`, status: statuses[i % 5] })
    }
    await s.refreshData()
    await showProjectBoard(mainWindow, projAbbrev, 'Perf task 0')
  })

  test('01 — memory baseline', async ({ mainWindow }) => {
    const mem = await mainWindow.evaluate(() => {
      const m = (performance as any).memory
      return {
        usedMB: Math.round(m.usedJSHeapSize / 1048576),
        totalMB: Math.round(m.totalJSHeapSize / 1048576),
        limitMB: Math.round(m.jsHeapSizeLimit / 1048576)
      }
    })
    metrics.memory = mem

    // Sanity: heap should be under 512MB for a fresh app
    expect(mem.usedMB).toBeLessThan(512)
  })

  test('02 — DOM node counts', async ({ mainWindow }) => {
    const dom = await mainWindow.evaluate(() => {
      const all = document.getElementsByTagName('*')
      const total = all.length
      const divs = document.getElementsByTagName('div').length
      const svgs = document.getElementsByTagName('svg').length
      let svgChildren = 0
      const svgEls = document.getElementsByTagName('svg')
      for (let i = 0; i < svgEls.length; i++) {
        svgChildren += svgEls[i].getElementsByTagName('*').length
      }
      return {
        totalNodes: total,
        divs,
        svgs,
        svgChildren,
        svgPctOfDOM: Math.round((svgChildren / total) * 100),
        canvases: document.getElementsByTagName('canvas').length,
        styleElements: document.getElementsByTagName('style').length
      }
    })
    metrics.dom = dom

    // DOM should stay under 20k nodes
    expect(dom.totalNodes).toBeLessThan(20_000)
    // SVGs shouldn't dominate the DOM
    expect(dom.svgPctOfDOM).toBeLessThan(50)
  })

  test('03 — paint timing', async ({ mainWindow }) => {
    const paint = await mainWindow.evaluate(() => {
      const entries = performance.getEntriesByType('paint')
      const fp = entries.find((e) => e.name === 'first-paint')
      const fcp = entries.find((e) => e.name === 'first-contentful-paint')
      return {
        firstPaint: Math.round(fp?.startTime ?? -1),
        firstContentfulPaint: Math.round(fcp?.startTime ?? -1)
      }
    })
    metrics.paint = paint

    // FCP under 5s is acceptable for Electron cold start
    if (paint.firstContentfulPaint > 0) {
      expect(paint.firstContentfulPaint).toBeLessThan(5_000)
    }

    // Resource timings, collected HERE rather than in a test of their own.
    // This was `04 — slowest resources`, a `test()` containing no assertion at
    // all: it could only ever report, so it added a pass/fail unit that could
    // not fail on purpose. It is kept at this point in the sequence rather than
    // moved to `afterAll` because the resource buffer keeps accumulating — read
    // at the end of the file it would rank a test-induced fetch as the app's
    // "slowest resource".
    metrics.resources = await mainWindow.evaluate(() => {
      const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
      const sorted = entries.slice().sort((a, b) => b.duration - a.duration)
      return {
        count: entries.length,
        slowest: sorted.slice(0, 10).map((e) => ({
          name: e.name.split('/').pop()?.substring(0, 60) ?? '',
          durationMs: Math.round(e.duration)
        }))
      }
    })
  })

  test('05 — IPC round-trip: loadBoardData', async ({ mainWindow }) => {
    const loadMs = await mainWindow.evaluate(async () => {
      const start = performance.now()
      await window.getTrpcVanillaClient().task.loadBoardData.query()
      return Math.round(performance.now() - start)
    })

    const createMs = await mainWindow.evaluate(async (pid: string) => {
      const start = performance.now()
      const task = await window
        .getTrpcVanillaClient()
        .task.create.mutate({ projectId: pid, title: 'timing-test' })
      const elapsed = Math.round(performance.now() - start)
      await window
        .getTrpcVanillaClient()
        .task.delete.mutate({ id: task.id })
        .catch(() => {})
      return elapsed
    }, projectId)

    const getProjectsMs = await mainWindow.evaluate(async () => {
      const start = performance.now()
      await window.getTrpcVanillaClient().projects.list.query()
      return Math.round(performance.now() - start)
    })

    metrics.ipc = { loadBoardDataMs: loadMs, createTaskMs: createMs, getProjectsMs: getProjectsMs }

    // Load-tolerant ceiling. The exact ms is recorded in metrics for trend tracking;
    // the assertion only guards against a GROSS regression. A tight 100ms budget
    // flaked under machine contention (concurrent app load inflates a renderer→WS→
    // sidecar→DB round-trip well past 100ms without any real regression). 500ms still
    // catches a 5×+ slowdown while surviving a loaded CI/dev machine.
    expect(loadMs).toBeLessThan(500)
    expect(createMs).toBeLessThan(500)
    expect(getProjectsMs).toBeLessThan(500)
  })

  test('06 — interaction: tab switch latency', async ({ mainWindow }) => {
    // Ensure the PerfTest board is shown before locating the card — earlier tests or
    // board refetch churn under load can leave it not-yet-painted, and a single
    // goHome+clickProject can fail to surface the board (card stays hidden). Retry the
    // nav until the card is visible. This precedes the measured goHome below, so it
    // doesn't affect the latency number.
    await showProjectBoard(mainWindow, projAbbrev, 'Perf task 0')
    // Open a task tab by double-clicking the kanban card
    const taskCard = mainWindow.getByText('Perf task 0').first()
    await taskCard.dblclick()
    // Wait for navigation to occur (URL or DOM change)
    await mainWindow.waitForTimeout(1_000)

    // Measure switching back to home
    const start = Date.now()
    await goHome(mainWindow)
    const switchMs = Date.now() - start

    metrics.interaction = {
      tabSwitchMs: switchMs,
      taskOpenMs: 0,
      refreshDataMs: 0
    }
    // Wait for home to render
    await mainWindow.waitForTimeout(500)
  })

  test('07 — interaction: task open latency', async ({ mainWindow }) => {
    const openMs = await mainWindow.evaluate(async () => {
      const start = performance.now()
      const card = document.querySelector('[data-task-card]') as HTMLElement
      card?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      return Math.round(performance.now() - start)
    })
    if (metrics.interaction) metrics.interaction.taskOpenMs = openMs

    // Go back home for next tests
    await goHome(mainWindow)
  })

  test('08 — interaction: refreshData latency', async ({ mainWindow }) => {
    const refreshMs = await mainWindow.evaluate(async () => {
      const start = performance.now()
      await (window as any).__slayzone_refreshData?.()
      return Math.round(performance.now() - start)
    })
    if (metrics.interaction) metrics.interaction.refreshDataMs = refreshMs

    expect(refreshMs).toBeLessThan(200)
  })

  test('09 — scaling: 100 tasks', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    // Add 90 more tasks (already have 10)
    for (let i = 10; i < 100; i++) {
      const statuses = ['inbox', 'in_progress', 'done', 'in_progress', 'inbox']
      await s.createTask({ projectId, title: `Scale task ${i}`, status: statuses[i % 5] })
    }
    await s.refreshData()

    // Wait for kanban to render
    await mainWindow.waitForTimeout(500)

    const scaleData = await mainWindow.evaluate(async () => {
      const mem = (performance as any).memory
      const loadStart = performance.now()
      await window.getTrpcVanillaClient().task.loadBoardData.query()
      const loadMs = Math.round(performance.now() - loadStart)
      return {
        taskCount: 100,
        domNodesAtScale: document.getElementsByTagName('*').length,
        memoryAtScaleMB: Math.round(mem.usedJSHeapSize / 1048576),
        loadBoardDataAtScaleMs: loadMs
      }
    })
    metrics.scaling = scaleData

    // DOM shouldn't explode with 100 tasks
    expect(scaleData.domNodesAtScale).toBeLessThan(30_000)
    // loadBoardData should still be fast
    expect(scaleData.loadBoardDataAtScaleMs).toBeLessThan(200)
  })

  test('10 — Playwright tracing snapshot', async ({ mainWindow }) => {
    // Use CDP to collect a 3-second runtime performance profile
    const cdp = await mainWindow.context().newCDPSession(mainWindow)

    await cdp.send('Performance.enable')
    const beforeMetrics = await cdp.send('Performance.getMetrics')

    // Interact during profiling
    await mainWindow.evaluate(() => {
      ;(window as any).__slayzone_refreshData?.()
    })
    await mainWindow.waitForTimeout(1_000)

    const afterMetrics = await cdp.send('Performance.getMetrics')
    await cdp.send('Performance.disable')

    const extract = (metrics: { metrics: Array<{ name: string; value: number }> }, name: string) =>
      metrics.metrics.find((m) => m.name === name)?.value ?? 0

    const cdpData = {
      jsHeapUsedBefore: Math.round(extract(beforeMetrics, 'JSHeapUsedSize') / 1048576),
      jsHeapUsedAfter: Math.round(extract(afterMetrics, 'JSHeapUsedSize') / 1048576),
      domNodes: extract(afterMetrics, 'Nodes'),
      jsEventListenersBefore: extract(beforeMetrics, 'JSEventListeners'),
      jsEventListeners: extract(afterMetrics, 'JSEventListeners'),
      jsEventListenersDelta:
        extract(afterMetrics, 'JSEventListeners') - extract(beforeMetrics, 'JSEventListeners'),
      layoutCount: extract(afterMetrics, 'LayoutCount'),
      recalcStyleCount: extract(afterMetrics, 'RecalcStyleCount'),
      layoutDuration: Math.round(extract(afterMetrics, 'LayoutDuration') * 1000),
      recalcStyleDuration: Math.round(extract(afterMetrics, 'RecalcStyleDuration') * 1000),
      scriptDuration: Math.round(extract(afterMetrics, 'ScriptDuration') * 1000),
      taskDuration: Math.round(extract(afterMetrics, 'TaskDuration') * 1000)
    }

    writePerfResults('cdp-metrics', cdpData)

    // Listener growth during the profiled interaction should stay bounded even if
    // the app shell has a large steady-state listener baseline.
    expect(cdpData.jsEventListenersDelta).toBeLessThan(1_000)
    // Dropped: `expect(cdpData.jsEventListeners).toBeLessThan(100_000)`. A
    // hundred thousand live listeners is not a bound this app can reach, so the
    // assertion could never fire — it read as coverage while providing none.
    // The delta bound above is the one that can actually catch a leak.
  })

  // Writing the report is teardown, not a test. As `11 — write results` it was
  // a `test()` with no assertion, and it could only run if every preceding test
  // had already run; as `afterAll` the profiling JSON is still produced when an
  // earlier case throws, which is exactly when the numbers are most wanted.
  test.afterAll(async () => {
    writePerfResults('profiling-results', metrics)
  })
})
