import { useEffect } from 'react'

// Warm latency-sensitive lazy chunks on idle so the FIRST keystroke that opens
// them doesn't pay the chunk-fetch cost (Suspense fallback is null → blank gap).
// Focused on keystroke-triggered surfaces; the dynamic-import specifier must match
// the one in lazy.ts so both share one chunk in the module cache.
const PRELOADS: Array<() => Promise<unknown>> = [
  // Cmd+K command palette (+ its cmdk/fzf deps). See lazy.ts `SearchDialog`.
  () => import('@/components/dialogs/SearchDialog')
]

export function useIdlePreload(): void {
  useEffect(() => {
    const ric: typeof requestIdleCallback =
      typeof requestIdleCallback === 'function'
        ? requestIdleCallback
        : (cb) => window.setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 0 } as IdleDeadline), 200)
    const cic: typeof cancelIdleCallback =
      typeof cancelIdleCallback === 'function' ? cancelIdleCallback : (id) => window.clearTimeout(id)

    const handle = ric(() => {
      for (const load of PRELOADS) load().catch(() => {})
    })
    return () => cic(handle)
  }, [])
}
