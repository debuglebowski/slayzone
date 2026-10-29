/**
 * Shared harness for the restored-many-tabs boot specs: `core/116-boot-idle-hydration`
 * (hydration order + a load-tolerant boot budget, in the default suite) and
 * `perf/boot-budget` (the same budget with the strict quiet-box bar). Both seed
 * the same 40-tab session, reload it with the boot probe installed, and read the
 * same census.
 */
import type { Page } from '@playwright/test'
import { test, expect, seed, openTaskById, resetApp, TEST_PROJECT_PATH } from './electron'
import { getMainSessionId, waitForPtySession } from './terminal'

export const BOOT_TABS = 40

/** Present once a task tab's detail page has mounted. */
export const BOOT_DETAIL = '[data-testid="terminal-mode-trigger"]'

export interface BootProbe {
  longTasks: Array<{ start: number; duration: number }>
  activeReadyAt: number
  mountedAtActiveReady: number
  nodesAtActiveReady: number
  activeTerminalAt: number
  allMountedAt: number
  allTerminalsAt: number
}

export type ProbeWindow = Window & {
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
export function installBootProbe({
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

/** Wipe the app and seed one project with {@link BOOT_TABS} terminal tasks. */
export async function seedBootTasks(page: Page, projectName: string): Promise<string[]> {
  await resetApp(page)
  const s = seed(page)
  const p = await s.createProject({ name: projectName, color: '#0ea5e9', path: TEST_PROJECT_PATH })
  const ids: string[] = []
  for (let i = 0; i < BOOT_TABS; i++) {
    const t = await s.createTask({
      projectId: p.id,
      title: `${projectName} ${i}`,
      status: 'in_progress',
      terminalMode: 'terminal'
    })
    ids.push(t.id)
  }
  await s.refreshData()
  return ids
}

/** Wait until the debounced viewState write holds a tab for every id. */
async function waitForPersistedTabs(page: Page, ids: string[]): Promise<void> {
  await expect
    .poll(
      async () => {
        const raw = await page.evaluate(() =>
          window.getTrpcVanillaClient().settings.get.query({ key: 'viewState' })
        )
        const tabs: Array<{ taskId?: string }> = raw ? (JSON.parse(raw).tabs ?? []) : []
        const persisted = new Set(tabs.map((t) => t.taskId))
        return ids.every((id) => persisted.has(id))
      },
      { timeout: 10_000 }
    )
    .toBe(true)
}

/**
 * Open every tab (first one active), let them all mount and spawn, and wait for
 * the persisted session to hold them — so a reload restores all of them. A no-op
 * when an earlier test left them open.
 */
export async function openBootTabs(page: Page, ids: string[]): Promise<void> {
  await openTaskById(page, ids[0])
  await page.evaluate((rest) => {
    const st = (window as unknown as ProbeWindow).__slayzone_tabStore.getState()
    for (const id of rest) st.openTaskInBackground(id)
  }, ids.slice(1))
  await expect
    .poll(() => page.locator(BOOT_DETAIL).count(), { timeout: 90_000, intervals: [500] })
    .toBeGreaterThanOrEqual(ids.length)
  for (const id of ids) await waitForPtySession(page, getMainSessionId(id), 30_000)
  // viewState persistence is debounced.
  await waitForPersistedTabs(page, ids)
}

/** How many of these tasks' terminals are attached to an on-page xterm. */
export function attachedTerminals(page: Page, ids: string[]): Promise<number> {
  return page.evaluate(
    (sids) =>
      sids.filter(
        (id) =>
          !!(window as unknown as ProbeWindow).__slayzone_terminalLinks?.[id]?._terminal?.element
      ).length,
    ids.map(getMainSessionId)
  )
}

/** CSS animations running on elements that are not visible — e.g. inside a hidden tab pane. */
export function hiddenRunningAnimations(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    document
      .getAnimations()
      .filter((a) => a.playState === 'running')
      .map((a) => (a.effect as KeyframeEffect | null)?.target ?? null)
      .filter(
        (t): t is Element =>
          t instanceof Element && !t.checkVisibility({ visibilityProperty: true })
      )
      .map((t) => `${t.tagName.toLowerCase()}.${String(t.className).slice(0, 60)}`)
  )
}

/** One restored-session boot, as the budget reads it. */
export interface BootMeasurement {
  activeReadyAt: number
  maxLongTask: number
  idleFraction: number
  bootBusyMs: number
  hiddenAnimations: string[]
  summary: string
}

/**
 * Open every tab, reload, and measure the boot: time to the active tab's detail
 * page, the longest task in the first 5s, main-thread busy once settled, and CSS
 * animations still running in hidden panes.
 */
export async function measureBoot(page: Page, ids: string[]): Promise<BootMeasurement> {
  await openBootTabs(page, ids)

  // Measures this one boot: removed right after it, so later reloads on the
  // worker's shared page don't run the census.
  const probeScript = await page.addInitScript(installBootProbe, {
    total: BOOT_TABS,
    detailSelector: BOOT_DETAIL
  })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  const taskSeconds = async (): Promise<number> => {
    const { metrics } = (await cdp.send('Performance.getMetrics')) as {
      metrics: Array<{ name: string; value: number }>
    }
    return metrics.find((m) => m.name === 'TaskDuration')?.value ?? 0
  }

  const busyBeforeReload = await taskSeconds()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await probeScript.dispose()
  // Settled = every hidden pane hydrated and every terminal attached.
  await expect
    .poll(() => page.locator(BOOT_DETAIL).count(), { timeout: 60_000, intervals: [250] })
    .toBeGreaterThanOrEqual(BOOT_TABS)
  await expect
    .poll(() => attachedTerminals(page, ids), { timeout: 60_000, intervals: [250] })
    .toBe(BOOT_TABS)
  // Past the 5s long-task window, plus a margin for post-hydration work.
  const sinceBoot = await page.evaluate(() => Math.round(performance.now()))
  await page.waitForTimeout(Math.max(2_000, 7_000 - sinceBoot))

  const IDLE_WINDOW_MS = 3_000
  const busy0 = await taskSeconds()
  // Sanity for the metric itself: the boot up to here was real main-thread work.
  const bootBusyMs = Math.round((busy0 - busyBeforeReload) * 1000)
  const t0 = Date.now()
  await page.waitForTimeout(IDLE_WINDOW_MS)
  const idleBusy = (await taskSeconds()) - busy0
  const idleFraction = idleBusy / ((Date.now() - t0) / 1000)

  const hiddenAnimations = await hiddenRunningAnimations(page)
  const { probe, detailMark } = await page.evaluate(() => ({
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
  return {
    activeReadyAt: probe.activeReadyAt,
    maxLongTask,
    idleFraction,
    bootBusyMs,
    hiddenAnimations,
    summary
  }
}

/**
 * The boot budget. Each bar sits well above a healthy boot and well below what
 * the regression it guards produced:
 * - active tab within `activeTabMs` — a reload stuck behind a WebSocket throttle
 *   added +2.4s;
 * - no long task over 200ms in the first 5s — all tabs mounting at once ran long
 *   tasks up to ~2s;
 * - under 15% main-thread busy once settled, and no CSS animation in a hidden
 *   pane — hidden-pane loading animations kept the main thread ~85% busy.
 *
 * Only the active-tab bar is wall-clock sensitive, so the caller picks it: a
 * healthy boot measured 0.77-1.07s inside the busy parallel suite, ~0.8s alone.
 */
export function expectBootBudget(m: BootMeasurement, activeTabMs: number): void {
  expect(m.bootBusyMs, m.summary).toBeGreaterThan(0)
  expect(m.activeReadyAt, m.summary).toBeGreaterThan(0)
  expect(m.activeReadyAt, m.summary).toBeLessThan(activeTabMs)
  expect(m.maxLongTask, m.summary).toBeLessThanOrEqual(200)
  expect(m.idleFraction, m.summary).toBeLessThan(0.15)
  expect(m.hiddenAnimations, m.summary).toEqual([])
}
