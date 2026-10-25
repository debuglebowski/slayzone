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
 */
import type { CDPSession } from '@playwright/test'
import { test, expect, seed, openTaskById, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import { getMainSessionId, waitForPtySession } from '../fixtures/terminal'

const TABS = 40
const DETAIL = '[data-testid="terminal-mode-trigger"]'

interface BootProbe {
  longTasks: Array<{ start: number; duration: number }>
  activeReadyAt: number
  mountedAtActiveReady: number
  nodesAtActiveReady: number
  activeTerminalAt: number
  allMountedAt: number
  allTerminalsAt: number
}

type ProbeWindow = Window & {
  __szBoot?: BootProbe
  __slayzone_tabStore: {
    getState: () => {
      openTask: (id: string) => void
      openTaskInBackground: (id: string) => void
      tabs: Array<{ type: string; taskId?: string }>
    }
  }
  __slayzone_terminalLinks?: Record<string, { _terminal?: { element?: HTMLElement } }>
}

/** Installed before the app boots (init script): long tasks + per-frame mount census. */
function installBootProbe({
  total,
  detailSelector
}: {
  total: number
  detailSelector: string
}): void {
  // Registered once per test that needs it; a page keeps every init script, so
  // a later registration must not install a second census.
  if ((window as unknown as { __szBoot?: BootProbe }).__szBoot) return
  const probe: BootProbe = {
    longTasks: [],
    activeReadyAt: -1,
    mountedAtActiveReady: -1,
    nodesAtActiveReady: -1,
    activeTerminalAt: -1,
    allMountedAt: -1,
    allTerminalsAt: -1
  }
  ;(window as unknown as { __szBoot: BootProbe }).__szBoot = probe
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        probe.longTasks.push({
          start: Math.round(e.startTime),
          duration: Math.round(e.duration)
        })
      }
    }).observe({ type: 'longtask', buffered: true })
  } catch {
    /* longtask unsupported */
  }
  const terminalsAttached = (): number => {
    const links =
      (
        window as unknown as {
          __slayzone_terminalLinks?: Record<string, { _terminal?: { element?: unknown } }>
        }
      ).__slayzone_terminalLinks ?? {}
    let n = 0
    for (const k in links) if (links[k]?._terminal?.element) n++
    return n
  }
  // Fine-grained until the active tab is ready, then coarse (the census itself
  // costs main-thread time — keep it equal and small in every run) for 10s.
  const census = (): void => {
    const now = Math.round(performance.now())
    if (probe.activeReadyAt < 0 && document.querySelector(`.z-10 ${detailSelector}`)) {
      probe.activeReadyAt = now
      probe.mountedAtActiveReady = document.querySelectorAll(detailSelector).length
      probe.nodesAtActiveReady = document.getElementsByTagName('*').length
    }
    if (probe.activeTerminalAt < 0 && document.querySelector('.z-10 .xterm')) {
      probe.activeTerminalAt = now
    }
    if (probe.activeReadyAt >= 0) {
      if (probe.allMountedAt < 0 && document.querySelectorAll(detailSelector).length >= total) {
        probe.allMountedAt = now
      }
      if (probe.allTerminalsAt < 0 && terminalsAttached() >= total) probe.allTerminalsAt = now
    }
    if (now < 10_000) setTimeout(census, probe.activeReadyAt < 0 ? 16 : 100)
  }
  // A timer, not rAF: frames are not produced while the test window is occluded.
  setTimeout(census, 16)
}

test.describe('boot idle hydration', () => {
  const taskIds: string[] = []

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Boot Hydr',
      color: '#0ea5e9',
      path: TEST_PROJECT_PATH
    })
    for (let i = 0; i < TABS; i++) {
      const t = await s.createTask({
        projectId: p.id,
        title: `Boot hydr ${i}`,
        status: 'in_progress',
        terminalMode: 'terminal'
      })
      taskIds.push(t.id)
    }
    await s.refreshData()
  })

  test('restored hidden tabs mount after the active tab, then all of them', async ({
    mainWindow
  }) => {
    test.setTimeout(240_000)
    // Open every tab (first one active) and let them all settle before the reload.
    await openTaskById(mainWindow, taskIds[0])
    await mainWindow.evaluate((ids) => {
      const st = (window as unknown as ProbeWindow).__slayzone_tabStore.getState()
      for (const id of ids) st.openTaskInBackground(id)
    }, taskIds.slice(1))
    await expect
      .poll(() => mainWindow.locator(DETAIL).count(), {
        timeout: 90_000,
        intervals: [500]
      })
      .toBeGreaterThanOrEqual(TABS)
    for (const id of taskIds) await waitForPtySession(mainWindow, getMainSessionId(id), 30_000)
    // viewState persistence is debounced.
    await mainWindow.waitForTimeout(1_500)

    await mainWindow.addInitScript(installBootProbe, {
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
    const sids = taskIds.map(getMainSessionId)
    await expect
      .poll(
        () =>
          mainWindow.evaluate(
            (ids) =>
              ids.filter(
                (id) =>
                  !!(window as unknown as ProbeWindow).__slayzone_terminalLinks?.[id]?._terminal
                    ?.element
              ).length,
            sids
          ),
        { timeout: 60_000, intervals: [250] }
      )
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

    // The active tab's detail mounts without the hidden ones riding along (a few
    // may hydrate in idle time while it waits on its own lazy panels).
    expect(probe.mountedAtActiveReady, summary).toBeLessThan(TABS / 4)
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
    await mainWindow.waitForTimeout(1_000)
    const warm = await reveal(taskIds[TABS - 2])
    const summary =
      `[boot-reveal] not-yet-hydrated reveal=${cold.ms}ms (panes mounted before: ${cold.mountedBefore}/${TABS}) ` +
      `hydrated reveal=${warm.ms}ms`
    test.info().annotations.push({ type: 'reveal', description: summary })
    console.log(summary)
  })

  /**
   * Boot budget guard. A restored 40-tab session must: show the active tab's
   * detail page within 1s of navigation start, run no long task over 200ms in
   * the first 5s, sit under 15% main-thread busy once settled, and run no CSS
   * animation inside a hidden pane. Each threshold sits well above what a healthy
   * boot measures here (see the summary line) and well below what the
   * regressions it guards produced: all-tabs-mount-at-once (active ready ~1.1s,
   * long tasks up to ~2s), hidden-pane loading animations (~85% main thread
   * busy at idle), and a reload stuck behind a WebSocket throttle (+2.4s).
   */
  test('boot stays within budget (active tab, long tasks, idle CPU, hidden animations)', async ({
    mainWindow
  }) => {
    test.setTimeout(240_000)
    // Self-contained: (re)open every tab — a no-op when an earlier test left them open.
    await openTaskById(mainWindow, taskIds[0])
    await mainWindow.evaluate((ids) => {
      const st = (window as unknown as ProbeWindow).__slayzone_tabStore.getState()
      for (const id of ids) st.openTaskInBackground(id)
    }, taskIds.slice(1))
    await expect
      .poll(() => mainWindow.locator(DETAIL).count(), { timeout: 90_000, intervals: [500] })
      .toBeGreaterThanOrEqual(TABS)
    for (const id of taskIds) await waitForPtySession(mainWindow, getMainSessionId(id), 30_000)
    await mainWindow.waitForTimeout(1_500)

    await mainWindow.addInitScript(installBootProbe, { total: TABS, detailSelector: DETAIL })
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
    // Settled = every hidden pane hydrated and every terminal attached.
    await expect
      .poll(() => mainWindow.locator(DETAIL).count(), { timeout: 60_000, intervals: [250] })
      .toBeGreaterThanOrEqual(TABS)
    const sids = taskIds.map(getMainSessionId)
    await expect
      .poll(
        () =>
          mainWindow.evaluate(
            (ids) =>
              ids.filter(
                (id) =>
                  !!(window as unknown as ProbeWindow).__slayzone_terminalLinks?.[id]?._terminal
                    ?.element
              ).length,
            sids
          ),
        { timeout: 60_000, intervals: [250] }
      )
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

    const { probe, hiddenAnimations, detailMark } = await mainWindow.evaluate(() => {
      const hidden = document
        .getAnimations()
        .filter((a) => a.playState === 'running')
        .map((a) => (a.effect as KeyframeEffect | null)?.target ?? null)
        .filter(
          (t): t is Element =>
            t instanceof Element && !t.checkVisibility({ visibilityProperty: true })
        )
        .map((t) => `${t.tagName.toLowerCase()}.${String(t.className).slice(0, 60)}`)
      return {
        probe: (window as unknown as ProbeWindow).__szBoot!,
        hiddenAnimations: hidden,
        detailMark: Math.round(
          performance.getEntriesByName('sz:activeTab:detail', 'mark')[0]?.startTime ?? -1
        )
      }
    })
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
