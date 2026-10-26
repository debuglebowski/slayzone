import { useState } from 'react'
import { useVisibleInterval } from './use-document-visibility'

export interface UseNowOptions {
  /** When false the clock stops ticking (keeps its last value). Default true. */
  enabled?: boolean
}

/**
 * The current time (epoch ms) as React state, for "elapsed / remaining" text.
 *
 * Reading `Date.now()` during render is impure — the React Compiler may memoize
 * it into a stale value (react-hooks/purity). The clock is instead sampled at
 * mount, on every `intervalMs` tick, and on re-enable / hidden → visible (so a
 * resumed clock is never a tick behind). Ticks pause while the window is hidden.
 */
export function useNow(intervalMs = 1000, options: UseNowOptions = {}): number {
  const { enabled = true } = options
  const [now, setNow] = useState(Date.now)
  useVisibleInterval(() => setNow(Date.now()), intervalMs, { enabled, runOnVisible: true })
  return now
}
