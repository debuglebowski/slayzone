import { useCallback, useEffect, useRef } from 'react'

export interface UseStablePollOptions {
  /** When false, polling is paused. Default true. */
  enabled?: boolean
  /** Delay between ticks while content is changing. Default 5000. */
  baseDelayMs?: number
  /** Cap on backoff delay when content is stable. Default 60000 (1 min). */
  maxDelayMs?: number
  /**
   * What the poll reads (e.g. a repo path), compared with `Object.is`. A change
   * restarts the loop: a tick runs at once and the backoff starts over. A tick still
   * running for the previous key is abandoned — its result feeds no backoff and arms
   * no timer, and neither the new tick nor `refetch()` waits for it. Dropping that
   * tick's side effects (setStates inside `fetchFn`) is the caller's job.
   */
  restartKey?: unknown
}

export interface UseStablePollResult {
  refetch: () => void
}

/**
 * Periodic poller with exponential backoff driven by the caller's
 * `fetchFn` return value.
 *
 * Each tick calls `fetchFn`; the caller is expected to hash + dedup its own
 * setStates inline (so an unchanged result produces zero React work). The
 * function's return value is the caller's hash — when two consecutive ticks
 * return the same value, the next tick's delay doubles up to `maxDelayMs`;
 * any difference snaps back to `baseDelayMs`.
 *
 * The hook intentionally does NOT track returned data in component state.
 * Storing data here would call `setState` on every change and cascade
 * re-renders into the calling component's subtree — defeating the purpose
 * of the inline dedup. Any caller that needs the data should keep it in
 * its own state.
 *
 * `fetchFn` is read through a ref so a fresh closure is used each tick
 * without restarting the timer. `enabled`, `baseDelayMs`, `maxDelayMs` and
 * `restartKey` changes restart the loop.
 */
export function useStablePoll<T = unknown>(
  fetchFn: () => Promise<T>,
  options: UseStablePollOptions = {}
): UseStablePollResult {
  const enabled = options.enabled !== false
  const baseDelay = options.baseDelayMs ?? 5000
  const maxDelay = options.maxDelayMs ?? 60_000
  const restartKey = options.restartKey

  const fetchRef = useRef(fetchFn)
  useEffect(() => {
    fetchRef.current = fetchFn
  })
  const refetchRef = useRef<() => void>(() => {
    // Placeholder until the effect below installs the real refetch. A caller
    // that fires `refetch()` before the first effect run (or while polling is
    // disabled) has no loop to restart, so dropping the call is correct.
  })

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    let delay = baseDelay
    let prev: T | null = null
    let firstTick = true
    // One tick at a time, one timer chain: a refetch() while a tick runs only marks
    // `rerun` (coalesced), and that tick starts the next one when it settles. Starting
    // a second tick instead overlapped fetches and left both ticks re-arming timers —
    // a second chain for good, multiplying the poll rate per mid-tick refetch.
    let running = false
    let rerun = false

    const settle = (): void => {
      if (rerun) {
        rerun = false
        delay = baseDelay
        void tick()
        return
      }
      timeout = setTimeout(tick, delay)
    }

    const tick = async (): Promise<void> => {
      timeout = null
      running = true
      let result: T | null = null
      try {
        result = await fetchRef.current()
      } catch {
        running = false
        if (cancelled) return
        delay = baseDelay
        settle()
        return
      }
      running = false
      if (cancelled) return
      if (!firstTick && result === prev) {
        delay = Math.min(delay * 2, maxDelay)
      } else {
        delay = baseDelay
      }
      prev = result
      firstTick = false
      settle()
    }

    refetchRef.current = (): void => {
      if (cancelled) return
      if (running) {
        rerun = true
        return
      }
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
      }
      delay = baseDelay
      void tick()
    }

    void tick()
    return () => {
      cancelled = true
      if (timeout) clearTimeout(timeout)
    }
    // `restartKey` isn't read in the loop: a new key only restarts it.
  }, [enabled, baseDelay, maxDelay, restartKey])

  const refetch = useCallback(() => refetchRef.current(), [])
  return { refetch }
}
