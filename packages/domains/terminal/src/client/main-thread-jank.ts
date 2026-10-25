/**
 * Whole-main-thread jank tracker, fed by the browser's `longtask` entries.
 *
 * Exists for the WebGL frame-time heartbeat (scramble-detector.ts Signal B). That
 * signal measures rAF cadence to catch a GPU that renders very slowly — but a rAF
 * delta also contains every long JS/style task on the shared main thread. During
 * a busy renderer boot (~50 tabs restoring) every terminal measured >50ms frames
 * and downgraded to the DOM renderer for the whole session, though the GPU was
 * fine. This module answers the two questions the heartbeat needs to tell those
 * apart: "has the thread settled?" and "did a long task overlap this frame?".
 *
 * Fallback when `longtask` observation is unavailable: the thread counts as
 * settled once {@link FALLBACK_SETTLED_AFTER_MS} have passed since page load and
 * no frame is ever discarded — i.e. the old (unfiltered) behaviour, but never
 * during boot.
 */

interface Span {
  start: number
  end: number
}

/** Long tasks kept for overlap queries — far more than one sampling window holds. */
const RING_CAP = 64
/** Quiet period (no long task) after which the thread counts as settled. */
export const SETTLE_QUIET_MS = 2_000
/** Earliest point the thread can count as settled, whatever the long-task feed says. */
export const MIN_SETTLED_AT_MS = 5_000
/** Settle time used when the browser does not expose `longtask` entries. */
export const FALLBACK_SETTLED_AFTER_MS = 20_000

const spans: Span[] = []
let lastLongTaskEnd = 0
let observing = false

function record(start: number, duration: number): void {
  const span = { start, end: start + duration }
  spans.push(span)
  if (spans.length > RING_CAP) spans.shift()
  if (span.end > lastLongTaskEnd) lastLongTaskEnd = span.end
}

function startObserving(): void {
  if (observing) return
  try {
    if (
      typeof PerformanceObserver === 'undefined' ||
      !PerformanceObserver.supportedEntryTypes?.includes('longtask')
    ) {
      return
    }
    const observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) record(e.startTime, e.duration)
    })
    // `buffered` replays the long tasks from before this module loaded — the
    // boot burst this module exists for.
    observer.observe({ type: 'longtask', buffered: true })
    observing = true
  } catch {
    observing = false
  }
}

startObserving()

/** True when a recorded long task overlaps `[from, to]` (performance.now() ms). */
export function overlapsLongTask(from: number, to: number): boolean {
  for (let i = spans.length - 1; i >= 0; i--) {
    const s = spans[i]
    if (s.start < to && s.end > from) return true
  }
  return false
}

/**
 * True once the main thread has gone {@link SETTLE_QUIET_MS} without a long task
 * (and the page is at least {@link MIN_SETTLED_AT_MS} old).
 */
export function isMainThreadSettled(now: number = performance.now()): boolean {
  if (!observing) return now >= FALLBACK_SETTLED_AFTER_MS
  if (now < MIN_SETTLED_AT_MS) return false
  return now - lastLongTaskEnd >= SETTLE_QUIET_MS
}

/** Test seam: inject a long task without a browser. */
export function __recordLongTaskForTest(start: number, duration: number): void {
  observing = true
  record(start, duration)
}

/** Test seam: forget every recorded long task. */
export function __resetLongTasksForTest(): void {
  spans.length = 0
  lastLongTaskEnd = 0
}
