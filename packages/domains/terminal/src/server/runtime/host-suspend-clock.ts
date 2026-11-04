/**
 * When this process last came back from a freeze: host sleep (a closed laptop
 * lid, macOS Maintenance Sleep), VM suspend, a stopped debugger. A watchdog
 * measuring silence by the wall clock must not judge a window this process was
 * not running for — the agent's network call died with the sleep and is
 * retrying, it is not stuck.
 *
 * Detected by a ticker's lateness, not a monotonic clock: libuv's monotonic
 * source ticks through system sleep on some platforms and not others (the same
 * reason `hub-gateway.ts`'s freeze guard measures lateness). A timer cannot fire
 * early anywhere, so a tick far later than its interval means the process was
 * frozen. `lastResumeAt()` samples too, so a watchdog timer that fires on wake
 * BEFORE the ticker's own catch-up tick still sees the freeze.
 *
 * @module terminal/server/runtime/host-suspend-clock
 */

export interface SuspendClock {
  /** Wall-clock ms when the latest freeze ended; 0 = none seen. */
  lastResumeAt(): number
}

/** How often the ticker samples the wall clock. */
const DEFAULT_TICK_MS = 1_000
/**
 * Lateness past one tick that counts as a freeze. Ordinary event-loop lag is
 * tens of milliseconds, seconds under heavy load; a sleep is seconds to hours. A
 * false freeze only grants the agent one more silence window; a missed one kills
 * a healthy agent.
 */
const DEFAULT_TOLERANCE_MS = 2_000

export function createSuspendClock(
  opts: { tickMs?: number; toleranceMs?: number } = {}
): SuspendClock & { dispose(): void } {
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS
  const toleranceMs = opts.toleranceMs ?? DEFAULT_TOLERANCE_MS
  let lastSampleAt = Date.now()
  let resumedAt = 0
  const sample = (): void => {
    const now = Date.now()
    if (now - lastSampleAt > tickMs + toleranceMs) resumedAt = now
    lastSampleAt = now
  }
  const timer = setInterval(sample, tickMs)
  timer.unref?.()
  return {
    lastResumeAt: () => {
      sample()
      return resumedAt
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
