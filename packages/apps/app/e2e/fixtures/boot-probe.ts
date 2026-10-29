/**
 * Shared harness for the restored-many-tabs boot specs: `core/116-boot-idle-hydration`
 * (hydration order, load-independent) and `perf/boot-budget` (wall-clock budgets,
 * quiet box only). Both seed the same 40-tab session, reload it with the boot
 * probe installed, and read the same census.
 */
import type { Page } from '@playwright/test'
import { expect, seed, openTaskById, resetApp, TEST_PROJECT_PATH } from './electron'
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
