import { useCallback, useInsertionEffect, useRef } from 'react'

/** Native-safe subscription handler: fixed identity, latest committed callback. */
export function useStableCallback<A extends unknown[], R>(
  fn: (...args: A) => R
): (...args: A) => R {
  const latest = useRef(fn)
  useInsertionEffect(() => {
    latest.current = fn
  })
  return useCallback((...args: A) => latest.current(...args), [])
}
