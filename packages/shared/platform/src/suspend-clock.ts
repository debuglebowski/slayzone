/**
 * Time this process actually ran, excluding freezes: host sleep (a closed laptop
 * lid, macOS Maintenance Sleep), VM suspend, a stopped debugger, a long
 * event-loop stall. A deadline or watchdog judging a peer's silence must not
 * count a window this process was not running for — a peer that slept too
 * could not answer, and a reply that arrived meanwhile could not be read.
 *
 * Detected by a ticker's lateness, not a monotonic clock: libuv's monotonic
 * source ticks through system sleep on some platforms and not others (on macOS,
 * Electron's node counts sleep, so a timer due during it fires the moment the
 * host wakes). A timer cannot fire early anywhere, so a tick far later than its
 * interval means the process was frozen. Asking samples too, so a timer that
 * fires on wake BEFORE the ticker's own catch-up tick still sees the freeze.
 *
 * @module platform/suspend-clock
 */

export interface SuspendClock {
  /** Wall-clock ms when the latest freeze ended; 0 = none seen. */
  lastResumeAt(): number
  /**
   * Ms that advance only while this process runs: wall time minus every freeze
   * seen. Compare two readings of the SAME clock; the origin means nothing.
   */
  awakeNow(): number
}

export type DisposableSuspendClock = SuspendClock & { dispose(): void }

/** How often the ticker samples the wall clock. */
const DEFAULT_TICK_MS = 1_000
/**
 * Lateness past one tick that counts as a freeze. Ordinary event-loop lag is
 * tens of milliseconds, seconds under heavy load; a sleep is seconds to hours. A
 * false freeze only lengthens a window by the lag; a missed one fails a healthy
 * peer.
 */
const DEFAULT_TOLERANCE_MS = 2_000

export function createSuspendClock(
  opts: { tickMs?: number; toleranceMs?: number } = {}
): DisposableSuspendClock {
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS
  const toleranceMs = opts.toleranceMs ?? DEFAULT_TOLERANCE_MS
  let lastSampleAt = Date.now()
  let resumedAt = 0
  let frozenMs = 0
  const sample = (): void => {
    const now = Date.now()
    const gap = now - lastSampleAt
    if (gap > tickMs + toleranceMs) {
      resumedAt = now
      // The tick that was due counts as running; the rest of the gap did not run.
      frozenMs += gap - tickMs
    } else if (gap < 0) {
      // A backwards wall-clock step (NTP) must not rewind awake time.
      frozenMs += gap
    }
    lastSampleAt = now
  }
  const timer = setInterval(sample, tickMs)
  timer.unref?.()
  return {
    lastResumeAt: () => {
      sample()
      return resumedAt
    },
    awakeNow: () => {
      sample()
      return Date.now() - frozenMs
    },
    dispose: () => clearInterval(timer)
  }
}

let processClock: SuspendClock | null = null

/** The process-wide clock, started on first use (one ticker per process). */
export function processSuspendClock(): SuspendClock {
  processClock ??= createSuspendClock()
  return processClock
}

export interface AwakeTimeouts {
  /**
   * `setTimeout`, but `ms` is counted in awake time: time the process was frozen
   * (host asleep, event loop stalled) does not use up the window. Returns cancel.
   */
  set(fn: () => void, ms: number): () => void
}

/**
 * Timeouts measured in awake time. The clock's ticker runs only while one is
 * pending, so an idle owner costs no wakeups — and the ticker always lives under
 * the same timer implementation as the timeouts it serves.
 *
 * A peer that is really gone still times out: after `ms` of time this process
 * was running, however many freezes interrupt it.
 */
export function createAwakeTimeouts(
  opts: { clock?: () => DisposableSuspendClock } = {}
): AwakeTimeouts {
  const makeClock = opts.clock ?? (() => createSuspendClock())
  let clock: DisposableSuspendClock | null = null
  let pending = 0
  const release = (): void => {
    pending -= 1
    if (pending === 0 && clock) {
      clock.dispose()
      clock = null
    }
  }
  return {
    set(fn, ms) {
      clock ??= makeClock()
      pending += 1
      const own = clock
      const due = own.awakeNow() + ms
      let done = false
      let timer: ReturnType<typeof setTimeout>
      const check = (): void => {
        const remaining = due - own.awakeNow()
        if (remaining > 0) {
          timer = setTimeout(check, remaining)
          return
        }
        done = true
        release()
        fn()
      }
      timer = setTimeout(check, ms)
      return () => {
        if (done) return
        done = true
        clearTimeout(timer)
        release()
      }
    }
  }
}
