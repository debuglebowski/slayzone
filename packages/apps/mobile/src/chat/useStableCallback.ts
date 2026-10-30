import { useCallback, useInsertionEffect, useRef } from 'react'

/**
 * A function with a fixed identity that always runs the latest `fn` — for handlers
 * that read refs or fast-changing state and are handed to a subscription (desktop's
 * `useStableCallback` from `@slayzone/ui`, which this app may not import). The latest
 * `fn` is adopted in an insertion effect, never during render; every caller (a
 * subscription's data, a press) runs after commit, so it always sees it.
 */
export function useStableCallback<A extends unknown[], R>(
  fn: (...args: A) => R
): (...args: A) => R {
  const ref = useRef(fn)
  useInsertionEffect(() => {
    ref.current = fn
  })
  return useCallback((...args: A) => ref.current(...args), [])
}
