import { useEffect, useState } from 'react'
import type { ChatScrollAnchor } from '@slayzone/terminal-contracts'

const THRESHOLD_PX = 70
/** Keys that scroll the timeline (the user's hand, like a wheel). */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])

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
  /**
   * Where the timeline is: following the bottom, or the first row with a
   * stable key (`data-anchor-key`) showing at the top and how far into it.
   * Null while the scroller is hidden (no height) or no keyed row shows.
   */
  captureAnchor: () => ChatScrollAnchor | null
  /** Put an anchor back. False when its row is not rendered (yet). */
  restoreAnchor: (anchor: ChatScrollAnchor) => boolean
  /** Whether growth keeps the view at the bottom (the lock, not the indicator). */
  isStuck: () => boolean
  /**
   * Stop following the bottom: the view is being moved somewhere on purpose
   * (a reveal). Held until the user scrolls by hand: landing at the bottom by
   * code does not re-engage it, so a revealed row that grows stays in view.
   */
  unstick: () => void
}

interface FollowBottomController {
  scrollRef: CallbackRef<HTMLElement>
  contentRef: CallbackRef<HTMLElement>
  scrollToBottom: () => void
  captureAnchor: () => ChatScrollAnchor | null
  restoreAnchor: (anchor: ChatScrollAnchor) => boolean
  isStuck: () => boolean
  unstick: () => void
  dispose: () => void
}

function isUserSelectingInside(root: HTMLElement): boolean {
  const sel = typeof window !== 'undefined' ? window.getSelection() : null
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false
  const node = sel.getRangeAt(0).commonAncestorContainer
  return root.contains(node) || node.contains(root)
}

/**
 * Imperative core of `useFollowBottom`, created once per hook instance. Lives
 * outside the hook because the callback refs mutate their own `.current` and
 * the scroll element — mutation the React Compiler won't allow on values it
 * sees as hook results.
 */
function createFollowBottomController(
  setIsAtBottom: (atBottom: boolean) => void
): FollowBottomController {
  const stuckRef = { current: true }
  /** `unstick()` was called: reaching the bottom re-engages only after user input. */
  const heldRef = { current: false }
  const resizeObserverRef: { current: ResizeObserver | null } = { current: null }

  const scrollRef = (() => {
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
      if (atBottom && !stuckRef.current && !heldRef.current) stuckRef.current = true
    }
    // Any scrolling by hand ends a hold: from then on the bottom re-engages.
    const userScrolls = () => {
      heldRef.current = false
    }
    const releaseStick = () => {
      const el = scrollRef.current
      if (!el) return
      if (el.scrollHeight <= el.clientHeight) return
      stuckRef.current = false
      setIsAtBottom(measureAtBottom(el))
    }
    const handleWheel = (e: WheelEvent) => {
      userScrolls()
      if (e.deltaY < 0) releaseStick()
    }
    const handleTouchMove = () => {
      userScrolls()
      releaseStick()
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (SCROLL_KEYS.has(e.key)) userScrolls()
      if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home') releaseStick()
    }
    // A press on the scrollbar (or the content) is the user's hand too.
    const handlePointerDown = () => userScrolls()
    const ref = ((el: HTMLElement | null) => {
      const prev = ref.current
      if (prev === el) return
      if (prev) {
        prev.removeEventListener('scroll', handleScroll)
        prev.removeEventListener('wheel', handleWheel)
        prev.removeEventListener('touchmove', handleTouchMove)
        prev.removeEventListener('keydown', handleKeyDown)
        prev.removeEventListener('pointerdown', handlePointerDown)
      }
      ref.current = el
      if (el) {
        el.addEventListener('scroll', handleScroll, { passive: true })
        el.addEventListener('wheel', handleWheel, { passive: true })
        el.addEventListener('touchmove', handleTouchMove, { passive: true })
        el.addEventListener('keydown', handleKeyDown)
        el.addEventListener('pointerdown', handlePointerDown, { passive: true })
      }
    }) as CallbackRef<HTMLElement>
    ref.current = null
    return ref
  })()

  const scrollNow = () => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }

  const scrollToBottom = () => {
    heldRef.current = false
    stuckRef.current = true
    setIsAtBottom(true)
    scrollNow()
  }

  const contentRef = (() => {
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
  })()

  const dispose = () => {
    resizeObserverRef.current?.disconnect()
    resizeObserverRef.current = null
  }

  const captureAnchor = (): ChatScrollAnchor | null => {
    const el = scrollRef.current
    if (!el || el.clientHeight === 0) return null
    if (stuckRef.current) return { atBottom: true }
    const top = el.getBoundingClientRect().top
    for (const row of el.querySelectorAll<HTMLElement>('[data-anchor-key]')) {
      const box = row.getBoundingClientRect()
      if (box.bottom > top) {
        return {
          atBottom: false,
          key: row.dataset.anchorKey ?? '',
          offsetPx: Math.round(top - box.top)
        }
      }
    }
    return null
  }

  const restoreAnchor = (anchor: ChatScrollAnchor): boolean => {
    if (anchor.atBottom) {
      scrollToBottom()
      return true
    }
    const el = scrollRef.current
    if (!el) return false
    const row = Array.from(el.querySelectorAll<HTMLElement>('[data-anchor-key]')).find(
      (r) => r.dataset.anchorKey === anchor.key
    )
    if (!row) return false
    // Stop following first: growth must not pull the restored position down.
    stuckRef.current = false
    el.scrollTop +=
      row.getBoundingClientRect().top - el.getBoundingClientRect().top + anchor.offsetPx
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    setIsAtBottom(dist <= THRESHOLD_PX)
    return true
  }

  const isStuck = (): boolean => stuckRef.current

  const unstick = (): void => {
    stuckRef.current = false
    heldRef.current = true
  }

  return {
    scrollRef,
    contentRef,
    scrollToBottom,
    captureAnchor,
    restoreAnchor,
    isStuck,
    unstick,
    dispose
  }
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
  const [isAtBottom, setIsAtBottom] = useState(true)
  // Created once; `scrollRef`, `contentRef` and `scrollToBottom` keep stable
  // identity for the hook's lifetime.
  const [controller] = useState(() => createFollowBottomController(setIsAtBottom))

  useEffect(() => () => controller.dispose(), [controller])

  return {
    scrollRef: controller.scrollRef,
    contentRef: controller.contentRef,
    isAtBottom,
    scrollToBottom: controller.scrollToBottom,
    captureAnchor: controller.captureAnchor,
    restoreAnchor: controller.restoreAnchor,
    isStuck: controller.isStuck,
    unstick: controller.unstick
  }
}
