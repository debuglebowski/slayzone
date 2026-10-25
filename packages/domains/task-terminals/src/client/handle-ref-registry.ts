import type { RefObject } from 'react'

/**
 * Per-key ref objects that survive re-renders: the first lookup of a key creates
 * its ref, later lookups return the same object. Lives in state (not a ref) so
 * render can hand the refs out — React Compiler forbids reading `ref.current`
 * during render, and a lookup here is idempotent, so memoizing it is safe.
 */
export type HandleRefRegistry<T> = Map<string, RefObject<T | null>>

export function createHandleRefRegistry<T>(): HandleRefRegistry<T> {
  return new Map()
}

export function handleRefFor<T>(registry: HandleRefRegistry<T>, key: string): RefObject<T | null> {
  let ref = registry.get(key)
  if (!ref) {
    ref = { current: null }
    registry.set(key, ref)
  }
  return ref
}
