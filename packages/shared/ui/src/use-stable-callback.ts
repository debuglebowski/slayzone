import { useCallback, useInsertionEffect, useRef } from 'react'

/**
 * A function with one identity for the component's lifetime that always runs the
 * `fn` of the latest committed render.
 *
 * For event handlers handed to memoized children — every open task tab is one. A
 * handler that closes over fast-changing state (the task list) would otherwise get a
 * new identity on each change and re-render every child. Not for functions called
 * during render: those would see the previous commit's `fn`.
 */
export function useStableCallback<A extends unknown[], R>(
  fn: (...args: A) => R
): (...args: A) => R {
  const latest = useRef(fn)
  // Insertion effects run before layout effects, so a child's layout effect that
  // calls the handler already sees this commit's `fn`.
  useInsertionEffect(() => {
    latest.current = fn
  })
  return useCallback((...args: A) => latest.current(...args), [])
}
