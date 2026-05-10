import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const THRESHOLD_PX = 70

/**
 * Callback ref that also exposes `.current` for imperative reads. Mirrors
 * the shape of React's `RefObject` so call sites can do both
 * `<div ref={scrollRef}>` and `scrollRef.current?.scrollTo(...)`.
 */
export interface CallbackRef<T> {
  (el: T | null): void
  current: T | null
}

export interface FollowBottomApi {
  scrollRef: CallbackRef<HTMLElement>
  contentRef: CallbackRef<HTMLElement>
  isAtBottom: boolean
  scrollToBottom: () => void
}

/**
 * Sticks scroll position to bottom of container when content grows.
 * Releases when user scrolls up via wheel/touch/keyboard. Re-engages
 * automatically once the user scrolls back within THRESHOLD_PX of bottom.
 *
 * `stuck` (lock state) and `isAtBottom` (UI indicator) are tracked
 * independently so a stale scroll event during streaming bursts cannot
 * falsely release the lock — releases require explicit user input.
 */
export function useFollowBottom(): FollowBottomApi {
  const stuckRef = useRef(true)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const [isAtBottom, setIsAtBottom] = useState(true)

  const isUserSelectingInside = useCallback((root: HTMLElement) => {
    const sel = typeof window !== 'undefined' ? window.getSelection() : null
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false
    const node = sel.getRangeAt(0).commonAncestorContainer
    return root.contains(node) || node.contains(root)
  }, [])

  const scrollRef = useMemo<CallbackRef<HTMLElement>>(() => {
    const measureAtBottom = (el: HTMLElement) => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight
      return dist <= THRESHOLD_PX
    }
    // Scroll events update the UI indicator and re-engage the stick when the
    // user scrolls back to bottom. They do NOT release the stick: a fast
    // streaming burst can produce a scroll event whose scrollTop lags the
    // freshly-grown scrollHeight, which would otherwise read "not at bottom"
    // and unstick the lock mid-stream. Release happens only on user input.
    const handleScroll = () => {
      const el = scrollRef.current
      if (!el) return
      const atBottom = measureAtBottom(el)
      setIsAtBottom(atBottom)
      if (atBottom && !stuckRef.current) stuckRef.current = true
    }
    const releaseStick = () => {
      const el = scrollRef.current
      if (!el) return
      if (el.scrollHeight <= el.clientHeight) return
      stuckRef.current = false
      setIsAtBottom(measureAtBottom(el))
    }
    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) releaseStick()
    }
    const handleTouchMove = () => releaseStick()
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home') releaseStick()
    }
    const ref = ((el: HTMLElement | null) => {
      const prev = ref.current
      if (prev === el) return
      if (prev) {
        prev.removeEventListener('scroll', handleScroll)
        prev.removeEventListener('wheel', handleWheel)
        prev.removeEventListener('touchmove', handleTouchMove)
        prev.removeEventListener('keydown', handleKeyDown)
      }
      ref.current = el
      if (el) {
        el.addEventListener('scroll', handleScroll, { passive: true })
        el.addEventListener('wheel', handleWheel, { passive: true })
        el.addEventListener('touchmove', handleTouchMove, { passive: true })
        el.addEventListener('keydown', handleKeyDown)
      }
    }) as CallbackRef<HTMLElement>
    ref.current = null
    return ref
  }, [])

  const scrollNow = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [scrollRef])

  const scrollToBottom = useCallback(() => {
    stuckRef.current = true
    setIsAtBottom(true)
    scrollNow()
  }, [scrollNow])

  const contentRef = useMemo<CallbackRef<HTMLElement>>(() => {
    const ref = ((el: HTMLElement | null) => {
      const prev = ref.current
      if (prev === el) return
      resizeObserverRef.current?.disconnect()
      resizeObserverRef.current = null
      ref.current = el
      if (!el) return
      let prevHeight = el.getBoundingClientRect().height
      const ro = new ResizeObserver((entries) => {
        const entry = entries[0]
        if (!entry) return
        const height = entry.contentRect.height
        const grew = height > prevHeight
        prevHeight = height
        if (!grew) return
        if (!stuckRef.current) return
        if (isUserSelectingInside(el)) return
        scrollNow()
      })
      ro.observe(el)
      resizeObserverRef.current = ro
      if (stuckRef.current) scrollNow()
    }) as CallbackRef<HTMLElement>
    ref.current = null
    return ref
  }, [isUserSelectingInside, scrollNow])

  useEffect(() => () => {
    resizeObserverRef.current?.disconnect()
    resizeObserverRef.current = null
  }, [])

  return { scrollRef, contentRef, isAtBottom, scrollToBottom }
}
