import { useEffect, useRef, useSyncExternalStore } from 'react'

const listeners = new Set<() => void>()
let listenerInstalled = false

function getSnapshot(): boolean {
  if (typeof document === 'undefined') return true
  return document.visibilityState === 'visible'
}

function getServerSnapshot(): boolean {
  return true
}

function ensureListener(): void {
  if (listenerInstalled || typeof document === 'undefined') return
  listenerInstalled = true
  document.addEventListener('visibilitychange', () => {
    for (const cb of listeners) cb()
  })
}

function subscribe(cb: () => void): () => void {
  ensureListener()
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/**
 * Returns whether the document is currently visible. One shared
 * `visibilitychange` listener is installed lazily and multiplexed via
 * `useSyncExternalStore` — adding N consumers does not add N listeners.
 *
 * SSR-safe: returns `true` if `document` is unavailable.
 */
export function useDocumentVisibility(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

export interface UseVisibleIntervalOptions {
  /** When false, no interval is armed. Default true. */
  enabled?: boolean
  /**
   * Fire the callback once when the document transitions hidden → visible.
   * Useful for data polls that want a catch-up tick on resume rather than
   * waiting a full `ms` for the next scheduled fire. Default false.
   */
  runOnVisible?: boolean
}

/**
 * Drop-in replacement for `setInterval` inside a React effect that pauses
 * while the document is hidden. The interval is cleared on hide and re-armed
 * on show — the callback never fires while hidden, so background CPU drops
 * to zero for the gated path.
 *
 * The callback is read through a ref, so callers can pass an inline closure
 * without restarting the timer.
 */
export function useVisibleInterval(
  callback: () => void,
  ms: number,
  options: UseVisibleIntervalOptions = {}
): void {
  const { enabled = true, runOnVisible = false } = options
  const isVisible = useDocumentVisibility()
  const callbackRef = useRef(callback)
  useEffect(() => {
    callbackRef.current = callback
  })

  useEffect(() => {
    if (!enabled || !isVisible) return
    if (runOnVisible) callbackRef.current()
    const id = setInterval(() => callbackRef.current(), ms)
    return () => clearInterval(id)
  }, [enabled, isVisible, ms, runOnVisible])
}
