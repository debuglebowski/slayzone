import { useCallback, useEffect, useRef, useState } from 'react'

export interface UseStablePollOptions<T> {
  /** When false, polling is paused. Default true. */
  enabled?: boolean
  /** Delay between ticks while content is changing. Default 5000. */
  baseDelayMs?: number
  /** Cap on backoff delay when content is stable. Default 60000 (1 min). */
  maxDelayMs?: number
  /**
   * Hash function used to detect "no change" between ticks. Default
   * `JSON.stringify`. Provide a faster shape-aware hash for large payloads.
   */
  hashFn?: (value: T | null) => string
}

export interface UseStablePollResult<T> {
  data: T | null
  isLoading: boolean
  refetch: () => void
}

const defaultHash = (v: unknown): string => {
  if (v == null) return 'null'
  try { return JSON.stringify(v) } catch { return String(v) }
}

/**
 * Polling hook with content-hash dedup and exponential backoff.
 *
 * Each tick calls `fetchFn`; if the hashed result matches the previous tick,
 * `setData` is skipped (no React re-render) and the next tick is delayed
 * `delay * 2`, capped at `maxDelayMs`. When content changes, `delay` snaps
 * back to `baseDelayMs`.
 *
 * Why this exists: ad-hoc `setInterval(fetchX, 5000)` patterns produce
 * referentially-new objects each tick → React reconciles huge subtrees even
 * when nothing changed → multi-second main-thread blocks under DEV-mode
 * validators. Hashing the payload eliminates the wasted reconciliation; the
 * backoff additionally reduces git/db work during idle periods.
 *
 * `fetchFn` is read through a ref so a fresh closure is used each tick
 * without restarting the timer. `enabled`, `baseDelayMs`, and `maxDelayMs`
 * changes restart the loop.
 */
export function useStablePoll<T>(
  fetchFn: () => Promise<T | null>,
  options: UseStablePollOptions<T> = {}
): UseStablePollResult<T> {
  const enabled = options.enabled !== false
  const baseDelay = options.baseDelayMs ?? 5000
  const maxDelay = options.maxDelayMs ?? 60_000
  const hashFn = options.hashFn ?? (defaultHash as (v: T | null) => string)

  const [data, setData] = useState<T | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const fetchRef = useRef(fetchFn)
  fetchRef.current = fetchFn
  const hashRef = useRef(hashFn)
  hashRef.current = hashFn
  const refetchRef = useRef<() => void>(() => {})

  useEffect(() => {
    if (!enabled) {
      setIsLoading(false)
      return
    }
    let cancelled = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    let delay = baseDelay
    let prevHash: string | null = null

    const tick = async (): Promise<void> => {
      let result: T | null = null
      try {
        result = await fetchRef.current()
      } catch {
        if (cancelled) return
        delay = baseDelay
        setIsLoading(false)
        timeout = setTimeout(tick, delay)
        return
      }
      if (cancelled) return
      const h = hashRef.current(result)
      if (h !== prevHash) {
        prevHash = h
        setData(result)
        delay = baseDelay
      } else {
        delay = Math.min(delay * 2, maxDelay)
      }
      setIsLoading(false)
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
  return { data, isLoading, refetch }
}
