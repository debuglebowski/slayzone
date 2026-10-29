/**
 * Boot budget guard for a restored 40-tab session — the wall-clock half of
 * `core/116-boot-idle-hydration.spec.ts` (same seed, same probe; see that spec for
 * the hydration design and its before/after numbers).
 *
 * Lives in the `perf` group because its thresholds are wall-clock: a healthy boot
 * measures ~0.8s to the active tab on a quiet box but ~1.05s inside the 7-way
 * parallel suite, which straddles the 1s bar. Run it alone: `pnpm test:e2e:perf`.
 * The bars are calibrated on a standard build — not a `SLAYZONE_PROFILE=1` one,
 * whose profiling React is slower.
 */
import { test, expect } from '../fixtures/electron'
import {
  BOOT_DETAIL as DETAIL,
  BOOT_TABS as TABS,
  attachedTerminals,
  hiddenRunningAnimations,
  installBootProbe,
  openBootTabs,
  seedBootTasks,
  type ProbeWindow
} from '../fixtures/boot-probe'

test.describe('boot budget', () => {
  let taskIds: string[] = []

  test.beforeAll(async ({ mainWindow }) => {
    taskIds = await seedBootTasks(mainWindow, 'Boot Budget')
  })

  /**
   * A restored 40-tab session must: show the active tab's detail page within 1s
   * of navigation start, run no long task over 200ms in the first 5s, sit under
   * 15% main-thread busy once settled, and run no CSS animation inside a hidden
   * pane. Each threshold sits well above what a healthy boot measures here (see
   * the summary line) and well below what the regressions it guards produced:
   * all-tabs-mount-at-once (active ready ~1.1s, long tasks up to ~2s), hidden-pane
   * loading animations (~85% main thread busy at idle), and a reload stuck behind
   * a WebSocket throttle (+2.4s).
   */
  test('boot stays within budget (active tab, long tasks, idle CPU, hidden animations)', async ({
    mainWindow
  }) => {
    test.setTimeout(240_000)
    await openBootTabs(mainWindow, taskIds)

    // Measures this one boot: removed right after it, so later perf specs that
    // reload the worker's shared page don't run the census.
    const probeScript = await mainWindow.addInitScript(installBootProbe, {
      total: TABS,
      detailSelector: DETAIL
    })
    const cdp = await mainWindow.context().newCDPSession(mainWindow)
    await cdp.send('Performance.enable')
    const taskSeconds = async (): Promise<number> => {
      const { metrics } = (await cdp.send('Performance.getMetrics')) as {
        metrics: Array<{ name: string; value: number }>
      }
      return metrics.find((m) => m.name === 'TaskDuration')?.value ?? 0
    }

    const busyBeforeReload = await taskSeconds()
    await mainWindow.reload({ waitUntil: 'domcontentloaded' })
    await probeScript.dispose()
    // Settled = every hidden pane hydrated and every terminal attached.
    await expect
      .poll(() => mainWindow.locator(DETAIL).count(), { timeout: 60_000, intervals: [250] })
      .toBeGreaterThanOrEqual(TABS)
    await expect
      .poll(() => attachedTerminals(mainWindow, taskIds), { timeout: 60_000, intervals: [250] })
      .toBe(TABS)
    // Past the 5s long-task window, plus a margin for post-hydration work.
    const sinceBoot = await mainWindow.evaluate(() => Math.round(performance.now()))
    await mainWindow.waitForTimeout(Math.max(2_000, 7_000 - sinceBoot))

    const IDLE_WINDOW_MS = 3_000
    const busy0 = await taskSeconds()
    // Sanity for the metric itself: the boot up to here was real main-thread work.
    const bootBusyMs = Math.round((busy0 - busyBeforeReload) * 1000)
    const t0 = Date.now()
    await mainWindow.waitForTimeout(IDLE_WINDOW_MS)
    const idleBusy = (await taskSeconds()) - busy0
    const idleFraction = idleBusy / ((Date.now() - t0) / 1000)

    const hiddenAnimations = await hiddenRunningAnimations(mainWindow)
    const { probe, detailMark } = await mainWindow.evaluate(() => ({
      probe: (window as unknown as ProbeWindow).__szBoot!,
      detailMark: Math.round(
        performance.getEntriesByName('sz:activeTab:detail', 'mark')[0]?.startTime ?? -1
      )
    }))
    const early = probe.longTasks.filter((t) => t.start < 5_000)
    const maxLongTask = Math.max(0, ...early.map((t) => t.duration))
    const summary =
      `[boot-budget] activeReadyAt=${probe.activeReadyAt}ms (mark ${detailMark}ms) ` +
      `longTasks<5s n=${early.length} max=${maxLongTask}ms ` +
      `boot main-thread=${bootBusyMs}ms idle main-thread=${(idleFraction * 100).toFixed(1)}% ` +
      `over ${IDLE_WINDOW_MS}ms ` +
      `hiddenAnimations=${hiddenAnimations.length}` +
      (hiddenAnimations.length ? ` ${JSON.stringify(hiddenAnimations.slice(0, 5))}` : '')
    test.info().annotations.push({ type: 'boot-budget', description: summary })
    console.log(summary)

    expect(bootBusyMs, summary).toBeGreaterThan(0)
    expect(probe.activeReadyAt, summary).toBeGreaterThan(0)
    expect(probe.activeReadyAt, summary).toBeLessThan(1_000)
    expect(maxLongTask, summary).toBeLessThanOrEqual(200)
    expect(idleFraction, summary).toBeLessThan(0.15)
    expect(hiddenAnimations, summary).toEqual([])
  })
})
