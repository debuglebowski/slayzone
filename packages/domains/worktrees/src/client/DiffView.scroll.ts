import { useCallback, useEffect, useRef } from 'react'

// ---- Scroll parent discovery ----
// Walk up from an element to the nearest scrollable ancestor so the virtualizer
// can hook into whatever container the consumer provided (split-view owns a
// scroll div). If an `absolute`-positioned ancestor sits between us and the
// scroll parent, we are nested inside an outer virtualizer (continuous-flow
// mode in GitDiffPanel) — virtualizing here would conflict with the outer
// virtualizer's position tracking. Return null in that case so the caller can
// fall back to plain rendering and let the outer virtualizer do its job.
export function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let cur = el?.parentElement ?? null
  let sawAbsolute = false
  while (cur) {
    const style = window.getComputedStyle(cur)
    if (style.position === 'absolute') sawAbsolute = true
    const overflowY = style.overflowY
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') {
      return sawAbsolute ? null : cur
    }
    cur = cur.parentElement
  }
  return null
}

// ---- Horizontal scroll sync (side-by-side, !wrap) ----
// Virtualization means N halves for visible rows instead of 2 per chunk, so we
// register every half with a shared ref set and broadcast scrollLeft on change.
export interface SbsSyncApi {
  register: (el: HTMLDivElement | null) => void
  onScroll: (e: React.UIEvent<HTMLDivElement>) => void
  scrollLeftRef: React.MutableRefObject<number>
}

export function useSbsSync(): SbsSyncApi {
  const elsRef = useRef<Set<HTMLDivElement>>(new Set())
  const scrollLeftRef = useRef(0)
  const syncingRef = useRef(false)

  const register = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    if (!elsRef.current.has(el)) {
      elsRef.current.add(el)
      // Bring new half in sync with the current scroll position so virtualized
      // rows that mount mid-scroll don't jump back to zero.
      if (el.scrollLeft !== scrollLeftRef.current) {
        el.scrollLeft = scrollLeftRef.current
      }
    }
  }, [])

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (syncingRef.current) return
    syncingRef.current = true
    const src = e.currentTarget
    const sl = src.scrollLeft
    scrollLeftRef.current = sl
    for (const el of elsRef.current) {
      if (el !== src && el.scrollLeft !== sl) el.scrollLeft = sl
    }
    syncingRef.current = false
  }, [])

  // Clean up disconnected elements on every render (cheap; set size = visible rows)
  useEffect(() => {
    const alive = new Set<HTMLDivElement>()
    for (const el of elsRef.current) {
      if (el.isConnected) alive.add(el)
    }
    elsRef.current = alive
  })

  return { register, onScroll, scrollLeftRef }
}
