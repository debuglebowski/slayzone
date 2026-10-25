/**
 * One `renderer.boot.timings` diagnostics event per renderer boot (load or
 * reload of the main window): the sz:* boot marks, long tasks in the first 10s
 * and the number of resources/modules the page loaded. Small on purpose — one
 * row per boot, a few hundred bytes — so slow boots in the field are visible
 * after the fact instead of only under a live trace.
 */

/** Long tasks counted from navigation start up to here. */
export const LONG_TASK_WINDOW_MS = 10_000
/** Wait at most this long for the hidden-pane hydration to drain before sending. */
export const MAX_WAIT_MS = 30_000

/** Payload field → performance mark it reads (first occurrence). */
export const BOOT_MARKS = {
  tabStoreStart: 'sz:tabStore:start',
  tabStoreEnd: 'sz:tabStore:end',
  reactMount: 'sz:reactMount',
  appMounted: 'sz:app:mounted',
  themeEnd: 'sz:theme:end',
  dataReady: 'sz:dataReady',
  activeTabDetail: 'sz:activeTab:detail',
  allHydrated: 'sz:panes:allHydrated'
} as const

export interface LongTaskLike {
  startTime: number
  duration: number
}

export interface BootTimingsInput {
  /** First startTime per mark name. */
  markAt: (name: string) => number | null
  longTasks: readonly LongTaskLike[]
  navigationType: string | null
  resources: ReadonlyArray<{ initiatorType: string }>
}

export interface BootTimingsPayload {
  nav: string | null
  marks: Record<keyof typeof BOOT_MARKS, number | null>
  longTasks: { n: number; totalMs: number; maxMs: number; windowMs: number }
  resources: { total: number; scripts: number }
}

export function buildBootTimingsPayload(input: BootTimingsInput): BootTimingsPayload {
  const marks = {} as Record<keyof typeof BOOT_MARKS, number | null>
  for (const key of Object.keys(BOOT_MARKS) as Array<keyof typeof BOOT_MARKS>) {
    const at = input.markAt(BOOT_MARKS[key])
    marks[key] = at == null ? null : Math.round(at)
  }
  const early = input.longTasks.filter((t) => t.startTime < LONG_TASK_WINDOW_MS)
  return {
    nav: input.navigationType,
    marks,
    longTasks: {
      n: early.length,
      totalMs: Math.round(early.reduce((sum, t) => sum + t.duration, 0)),
      maxMs: Math.round(early.reduce((max, t) => Math.max(max, t.duration), 0)),
      windowMs: LONG_TASK_WINDOW_MS
    },
    resources: {
      total: input.resources.length,
      scripts: input.resources.filter((r) => r.initiatorType === 'script').length
    }
  }
}

/**
 * Start observing; sends once, at LONG_TASK_WINDOW_MS after navigation start or
 * as soon after that as the hidden panes have all hydrated (capped at
 * MAX_WAIT_MS). Never throws — telemetry must not break a boot.
 */
export function startBootTimingsReport(send: (payload: BootTimingsPayload) => void): void {
  if (typeof performance === 'undefined' || typeof PerformanceObserver === 'undefined') return
  const longTasks: LongTaskLike[] = []
  let longTaskObserver: PerformanceObserver | null = null
  try {
    longTaskObserver = new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        longTasks.push({ startTime: e.startTime, duration: e.duration })
    })
    longTaskObserver.observe({ type: 'longtask', buffered: true })
  } catch {
    longTaskObserver = null
  }

  const markAt = (name: string): number | null => {
    const entries = performance.getEntriesByName(name, 'mark')
    return entries.length > 0 ? entries[0].startTime : null
  }
  let sent = false
  const finish = (): void => {
    if (sent) return
    sent = true
    longTaskObserver?.disconnect()
    try {
      const nav = performance.getEntriesByType('navigation')[0] as
        | PerformanceNavigationTiming
        | undefined
      send(
        buildBootTimingsPayload({
          markAt,
          longTasks,
          navigationType: nav?.type ?? null,
          resources: performance.getEntriesByType('resource') as PerformanceResourceTiming[]
        })
      )
    } catch {
      /* telemetry is best-effort */
    }
  }
  const check = (): void => {
    if (sent) return
    const now = performance.now()
    if (
      now >= MAX_WAIT_MS ||
      (now >= LONG_TASK_WINDOW_MS && markAt(BOOT_MARKS.allHydrated) != null)
    ) {
      finish()
      return
    }
    // Before the window closes, wake at its end; after, poll the drain mark
    // once a second (a single getEntriesByName — negligible).
    setTimeout(check, now < LONG_TASK_WINDOW_MS ? LONG_TASK_WINDOW_MS - now : 1_000)
  }
  check()
}
