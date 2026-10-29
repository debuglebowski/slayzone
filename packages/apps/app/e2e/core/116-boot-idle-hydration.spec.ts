/**
 * A renderer boot that restores many task tabs mounts the ACTIVE tab's detail
 * page at once and hydrates the hidden ones afterwards, one per idle slice.
 *
 * Measured on a 52-tab dev session before: every restored tab mounted its full
 * TaskDetail in the same commit (52 skeleton→detail swaps at 1.1s), so the first
 * forced layout ran over 15.6k elements and the active tab painted behind ~5ms of
 * render JS + ~450 DOM nodes per hidden tab. In this spec (40 tabs, reload):
 * active tab ready at ~1.12s with all 40 mounted (6.3k elements), 32-35 long
 * tasks (~2s) in the first 5s; after: ~0.5s with 1 mounted (2.2k elements), no
 * long tasks, every hidden tab mounted by ~2s.
 *
 * Every hidden tab must still end up mounted (and its terminal attached) shortly
 * after boot — hydration only defers, it never skips.
 *
 * This runs inside the busy 7-way parallel suite, so its one wall-clock bar is
 * load-tolerant (active tab within 2s). `perf/boot-budget.spec.ts` runs the same
 * budget with the strict quiet-box bar (1s).
 */
import type { CDPSession } from '@playwright/test'
import { test, expect } from '../fixtures/electron'
import {
  BOOT_DETAIL as DETAIL,
  BOOT_TABS as TABS,
  attachedTerminals,
  expectBootBudget,
  installBootProbe,
  measureBoot,
  openBootTabs,
  seedBootTasks,
  type ProbeWindow
} from '../fixtures/boot-probe'

test.describe('boot idle hydration', () => {
  let taskIds: string[] = []

  test.beforeAll(async ({ mainWindow }) => {
    taskIds = await seedBootTasks(mainWindow, 'Boot Hydr')
  })

  test('restored hidden tabs mount after the active tab, then all of them', async ({
    mainWindow
  }) => {
    test.setTimeout(240_000)
    // Open every tab (first one active) and let them all settle before the reload.
    await openBootTabs(mainWindow, taskIds)

    // Measures this one boot: removed right after it, so later reloads on the
    // worker's shared page don't run the census.
    const probeScript = await mainWindow.addInitScript(installBootProbe, {
      total: TABS,
      detailSelector: DETAIL
    })
    let cdp: CDPSession | null = null
    try {
      cdp = await mainWindow.context().newCDPSession(mainWindow)
      await cdp.send('Performance.enable')
    } catch {
      cdp = null
    }
    const METRICS = ['TaskDuration', 'ScriptDuration', 'RecalcStyleDuration', 'LayoutDuration']
    const metrics = async (): Promise<Record<string, number>> => {
      if (!cdp) return {}
      const { metrics: all } = (await cdp.send('Performance.getMetrics')) as {
        metrics: Array<{ name: string; value: number }>
      }
      return Object.fromEntries(
        all.filter((m) => METRICS.includes(m.name)).map((m) => [m.name, m.value])
      )
    }
    const delta = (a: Record<string, number>, b: Record<string, number>): string =>
      METRICS.map(
        (k) => `${k.replace('Duration', '')}=${Math.round(((b[k] ?? 0) - (a[k] ?? 0)) * 1000)}`
      ).join(' ')

    const before = await metrics()
    await mainWindow.reload({ waitUntil: 'domcontentloaded' })
    await probeScript.dispose()
    await mainWindow.waitForTimeout(5_000)
    const at5 = await metrics()
    const diag = (): Promise<string> =>
      mainWindow.evaluate(
        (sel) =>
          JSON.stringify({
            probe: (window as unknown as ProbeWindow).__szBoot ?? null,
            mounted: document.querySelectorAll(sel).length,
            visibility: document.visibilityState,
            tabs: (window as unknown as ProbeWindow).__slayzone_tabStore
              ?.getState()
              .tabs.filter((t) => t.type === 'task').length
          }),
        DETAIL
      )
    await expect
      .poll(() => mainWindow.locator(DETAIL).count(), {
        timeout: 60_000,
        intervals: [250]
      })
      .toBeGreaterThanOrEqual(TABS)
      .catch(async (e: unknown) => {
        throw new Error(`${String(e)}\n${await diag()}`)
      })
    // Every hidden terminal still attaches to its (surviving) PTY.
    await expect
      .poll(() => attachedTerminals(mainWindow, taskIds), { timeout: 60_000, intervals: [250] })
      .toBe(TABS)
    const sinceBoot = await mainWindow.evaluate(() => Math.round(performance.now()))
    await mainWindow.waitForTimeout(Math.max(0, 10_500 - sinceBoot))
    const at10 = await metrics()
    const probe = (await mainWindow.evaluate(() => (window as unknown as ProbeWindow).__szBoot))!

    const lt = (until: number): Array<{ start: number; duration: number }> =>
      probe.longTasks.filter((t) => t.start < until)
    const sum = (a: Array<{ duration: number }>): number => a.reduce((n, t) => n + t.duration, 0)
    const summary =
      `[boot-hydration] tabs=${TABS} activeReadyAt=${probe.activeReadyAt}ms ` +
      `activeTerminalAt=${probe.activeTerminalAt}ms mountedAtActiveReady=${probe.mountedAtActiveReady} ` +
      `nodesAtActiveReady=${probe.nodesAtActiveReady} allMountedAt=${probe.allMountedAt}ms ` +
      `allTerminalsAt=${probe.allTerminalsAt}ms ` +
      `longTasks<5s n=${lt(5_000).length} sum=${sum(lt(5_000))}ms max=${Math.max(0, ...lt(5_000).map((t) => t.duration))}ms ` +
      `longTasks<10s n=${lt(10_000).length} sum=${sum(lt(10_000))}ms ` +
      `main-thread ms 0-5s: ${delta(before, at5)} | 0-10s: ${delta(before, at10)}\n` +
      `  longTasks<5s: ${JSON.stringify(lt(5_000))}`
    test.info().annotations.push({ type: 'boot', description: summary })
    console.log(summary)

    // The active tab's detail mounts without the hidden ones riding along. Some
    // hydrate in idle time while it waits on its own lazy panels — more the
    // slower the box (measured: 5-6 alone, 10 inside the parallel suite) — so the
    // bar sits between that and the regression this guards (all 40 at once).
    expect(probe.mountedAtActiveReady, summary).toBeLessThan(TABS / 2)
  })
  test('revealing a hidden tab before its turn shows its detail page at once', async ({
    mainWindow
  }) => {
    // Restored tabs from the previous test. Reveal the tab hydration reaches
    // last, right after the boot, then (for comparison) one that is already
    // hydrated. Both are timed from the switch to the frame-ready DOM.
    test.setTimeout(120_000)
    await mainWindow.reload({ waitUntil: 'domcontentloaded' })
    await expect(mainWindow.locator(`.z-10 ${DETAIL}`)).toBeVisible({ timeout: 15_000 })
    const reveal = (id: string): Promise<{ ms: number; mountedBefore: number }> =>
      mainWindow.evaluate(
        async ({ id, sel }) => {
          const w = window as unknown as ProbeWindow
          const st = w.__slayzone_tabStore.getState()
          const idx = st.tabs.findIndex((t) => t.taskId === id)
          const container = document.querySelector(`.z-10 ${sel}`)?.closest('.z-10')?.parentElement
          const mountedBefore = document.querySelectorAll(sel).length
          const t0 = performance.now()
          st.openTask(id)
          for (;;) {
            const pane = container?.children[idx]
            if (pane?.classList.contains('z-10') && pane.querySelector(sel)) break
            await new Promise((r) => setTimeout(r, 0))
          }
          await new Promise((r) => requestAnimationFrame(() => r(null)))
          return { ms: Math.round(performance.now() - t0), mountedBefore }
        },
        { id, sel: DETAIL }
      )
    const cold = await reveal(taskIds[TABS - 1])
    await expect
      .poll(() => mainWindow.locator(DETAIL).count(), { timeout: 60_000, intervals: [250] })
      .toBeGreaterThanOrEqual(TABS)
    // Fixed wait: let post-hydration work drain so the warm reveal isn't timed mid-burst.
    await mainWindow.waitForTimeout(1_000)
    const warm = await reveal(taskIds[TABS - 2])
    const summary =
      `[boot-reveal] not-yet-hydrated reveal=${cold.ms}ms (panes mounted before: ${cold.mountedBefore}/${TABS}) ` +
      `hydrated reveal=${warm.ms}ms`
    test.info().annotations.push({ type: 'reveal', description: summary })
    console.log(summary)
  })

  test('boot stays within budget (active tab under 2s, long tasks, idle CPU, hidden animations)', async ({
    mainWindow
  }) => {
    test.setTimeout(240_000)
    expectBootBudget(await measureBoot(mainWindow, taskIds), 2_000)
  })
})
