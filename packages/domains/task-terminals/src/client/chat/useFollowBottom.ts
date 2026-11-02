import { useEffect, useState } from 'react'
import type { ChatScrollAnchor } from '@slayzone/terminal-contracts'

const THRESHOLD_PX = 70
/** Keys that scroll the timeline (the user's hand, like a wheel). */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])

/** Align the message end with the viewport; trailing padding stays manually scrollable. */
export function getFollowBottomOffset(el: HTMLElement): number {
  const content = el.querySelector<HTMLElement>('[data-chat-scroll-content]')
  const padding = content ? Number.parseFloat(getComputedStyle(content).paddingBottom) || 0 : 0
  return Math.max(0, el.scrollHeight - padding - el.clientHeight)
}

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
  /**
   * Whether growth keeps the view at the bottom (the lock, not the indicator).
   * Reading it first lets go if the user moved the view since the lock last
   * placed it (see `releaseIfMovedByUser`).
   */
  isStuck: () => boolean
  /**
   * Put the view at the bottom as the lock's own move (callers that follow
   * growth themselves: the virtual timeline after each commit). Only while
   * `isStuck()`. A plain `scrollTop` write would read as the user's move.
   */
  followBottom: () => void
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
  followBottom: () => void
  unstick: () => void
  setAutoScroll: (enabled: boolean) => void
  dispose: () => void
}

export function isUserSelectingInside(root: HTMLElement): boolean {
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
  const autoScrollRef = { current: true }
  const stuckRef = { current: true }
  /** `unstick()` was called: reaching the bottom re-engages only after user input. */
  const heldRef = { current: false }
  const resizeObserverRef: { current: ResizeObserver | null } = { current: null }
  /**
   * Where the view was at the last scroll event or the lock's own move. A view
   * found elsewhere was moved since: the browser scrolls BEFORE it sends the
   * wheel or scroll event (passive wheel, scrollbar drag).
   */
  const lastTopRef = { current: 0 }
  /** A press on the scroller (its scrollbar) is held: a move up is a drag. */
  const pointerHeldRef = { current: false }

  /**
   * Let go when the view is where following never puts it — the user moved
   * it: down past the message end into the trailing padding (growth would pull
   * it back up), or up while a press is held (a scrollbar drag sends no
   * wheel). Checked on every follow decision, not just scroll events: a commit
   * between the browser's scroll and its event re-aligns the view (the virtual
   * timeline follows after each commit) and would erase the move. A move up
   * alone does not let go: a fast streaming burst can leave scrollTop lagging
   * a grown scrollHeight, and a shrink only ever clamps it down.
   */
  const releaseIfMovedByUser = (el: HTMLElement): void => {
    if (!stuckRef.current) return
    const top = el.scrollTop
    const last = lastTopRef.current
    const pastEnd = top > last + 1 && getFollowBottomOffset(el) - top < -THRESHOLD_PX
    const dragged = pointerHeldRef.current && top < last - 1
    if (pastEnd || dragged) stuckRef.current = false
  }

  const isStuck = (): boolean => {
    const el = scrollRef.current
    if (el) releaseIfMovedByUser(el)
    return autoScrollRef.current && stuckRef.current
  }

  const scrollRef = (() => {
    const measureAtBottom = (el: HTMLElement) => {
      const dist = getFollowBottomOffset(el) - el.scrollTop
      return dist <= THRESHOLD_PX
    }
    // Scroll events update the UI indicator, let go on a move by the user, and
    // re-engage on a move TOWARD the end that lands within THRESHOLD_PX of it
    // — so a small scroll up that stays near the end does not re-stick on its
    // own event.
    const handleScroll = () => {
      const el = scrollRef.current
      if (!el) return
      releaseIfMovedByUser(el)
      const top = el.scrollTop
      const target = getFollowBottomOffset(el)
      const dist = target - top
      const prevDist = target - lastTopRef.current
      lastTopRef.current = top
      setIsAtBottom(dist <= THRESHOLD_PX)
      if (stuckRef.current || heldRef.current) return
      if (Math.abs(dist) <= THRESHOLD_PX && Math.abs(dist) < Math.abs(prevDist)) {
        stuckRef.current = true
      }
    }
    // Any scrolling by hand ends a hold: from then on the bottom re-engages.
    // The scroll it causes may already have happened (passive listeners).
    const userScrolls = () => {
      heldRef.current = false
      const el = scrollRef.current
      if (el) releaseIfMovedByUser(el)
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
    const handlePointerUp = () => {
      pointerHeldRef.current = false
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
    }
    const handlePointerDown = () => {
      userScrolls()
      pointerHeldRef.current = true
      window.addEventListener('pointerup', handlePointerUp)
      window.addEventListener('pointercancel', handlePointerUp)
    }
    const ref = ((el: HTMLElement | null) => {
      const prev = ref.current
      if (prev === el) return
      if (prev) {
        resizeObserverRef.current?.unobserve(prev)
        prev.removeEventListener('scroll', handleScroll)
        prev.removeEventListener('wheel', handleWheel)
        prev.removeEventListener('touchmove', handleTouchMove)
        prev.removeEventListener('keydown', handleKeyDown)
        prev.removeEventListener('pointerdown', handlePointerDown)
        handlePointerUp()
      }
      ref.current = el
      if (el) {
        lastTopRef.current = el.scrollTop
        resizeObserverRef.current?.observe(el)
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

  /** The lock's own move to the bottom: recorded, so it never reads as the user's. */
  const scrollNow = () => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = getFollowBottomOffset(el)
    lastTopRef.current = el.scrollTop
  }

  const followBottom = (): void => {
    const el = scrollRef.current
    if (!el || !isStuck()) return
    const target = getFollowBottomOffset(el)
    if (Math.abs(el.scrollTop - target) > 1) el.scrollTop = target
    lastTopRef.current = el.scrollTop
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
      // ResizeObserver reports the content box. Comparing its first delivery
      // with the border box would miss growth smaller than the bottom padding.
      const style = getComputedStyle(el)
      const inset = [
        style.paddingTop,
        style.paddingBottom,
        style.borderTopWidth,
        style.borderBottomWidth
      ].reduce((sum, value) => sum + (Number.parseFloat(value) || 0), 0)
      let prevHeight = Math.max(0, el.getBoundingClientRect().height - inset)
      const ro = new ResizeObserver((entries) => {
        const entry = entries.find((entry) => entry.target === el)
        const grew = entry !== undefined && entry.contentRect.height > prevHeight
        if (entry) prevHeight = entry.contentRect.height
        // Composer growth shrinks the viewport without growing the content.
        // Following must survive that resize too; reading history stays put.
        const viewportChanged = entries.some((entry) => entry.target === scrollRef.current)
        if (!grew && !viewportChanged) return
        if (!isStuck()) {
          // Not following: the end moved away (no scroll event says so).
          const scroller = scrollRef.current
          if (scroller) {
            setIsAtBottom(getFollowBottomOffset(scroller) - scroller.scrollTop <= THRESHOLD_PX)
          }
          return
        }
        if (isUserSelectingInside(el)) return
        scrollNow()
      })
      ro.observe(el)
      if (scrollRef.current) ro.observe(scrollRef.current)
      resizeObserverRef.current = ro
      if (isStuck()) scrollNow()
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
    if (isStuck()) return { atBottom: true }
    const top = el.getBoundingClientRect().top
    for (const row of el.querySelectorAll<HTMLElement>('[data-anchor-key]')) {
      const box = row.getBoundingClientRect()
      if (box.bottom > top) {
        const at = row.dataset.row === undefined ? Number.NaN : Number(row.dataset.row)
        return {
          atBottom: false,
          key: row.dataset.anchorKey ?? '',
          offsetPx: Math.round(top - box.top),
          ...(Number.isInteger(at) && at >= 0 ? { row: at } : {})
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
    const dist = getFollowBottomOffset(el) - el.scrollTop
    setIsAtBottom(dist <= THRESHOLD_PX)
    return true
  }

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
    followBottom,
    unstick,
    setAutoScroll: (enabled) => {
      autoScrollRef.current = enabled
    },
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
export function useFollowBottom(autoScroll = true): FollowBottomApi {
  const [isAtBottom, setIsAtBottom] = useState(true)
  // Created once; `scrollRef`, `contentRef` and `scrollToBottom` keep stable
  // identity for the hook's lifetime.
  const [controller] = useState(() => createFollowBottomController(setIsAtBottom))

  useEffect(() => {
    controller.setAutoScroll(autoScroll)
  }, [controller, autoScroll])
  useEffect(() => () => controller.dispose(), [controller])

  return {
    scrollRef: controller.scrollRef,
    contentRef: controller.contentRef,
    isAtBottom,
    scrollToBottom: controller.scrollToBottom,
    captureAnchor: controller.captureAnchor,
    restoreAnchor: controller.restoreAnchor,
    isStuck: controller.isStuck,
    followBottom: controller.followBottom,
    unstick: controller.unstick
  }
}
