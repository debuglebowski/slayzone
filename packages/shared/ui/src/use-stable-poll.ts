import { useCallback, useEffect, useRef } from 'react'

export interface UseStablePollOptions {
  /** When false, polling is paused. Default true. */
  enabled?: boolean
  /** Delay between ticks while content is changing. Default 5000. */
  baseDelayMs?: number
  /** Cap on backoff delay when content is stable. Default 60000 (1 min). */
  maxDelayMs?: number
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
 * without restarting the timer. `enabled`, `baseDelayMs`, and `maxDelayMs`
 * changes restart the loop.
 */
export function useStablePoll<T = unknown>(
  fetchFn: () => Promise<T>,
  options: UseStablePollOptions = {}
): UseStablePollResult {
  const enabled = options.enabled !== false
  const baseDelay = options.baseDelayMs ?? 5000
  const maxDelay = options.maxDelayMs ?? 60_000

  const fetchRef = useRef(fetchFn)
  useEffect(() => {
    fetchRef.current = fetchFn
  })
  const refetchRef = useRef<() => void>(() => {})

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    let delay = baseDelay
    let prev: T | null = null
    let firstTick = true

    const tick = async (): Promise<void> => {
      let result: T | null = null
      try {
        result = await fetchRef.current()
      } catch {
        if (cancelled) return
        delay = baseDelay
        timeout = setTimeout(tick, delay)
        return
      }
      if (cancelled) return
      if (!firstTick && result === prev) {
        delay = Math.min(delay * 2, maxDelay)
      } else {
        delay = baseDelay
      }
      prev = result
      firstTick = false
      timeout = setTimeout(tick, delay)
    }

    refetchRef.current = (): void => {
      if (cancelled) return
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
  }, [enabled, baseDelay, maxDelay])

  const refetch = useCallback(() => refetchRef.current(), [])
  return { refetch }
}
