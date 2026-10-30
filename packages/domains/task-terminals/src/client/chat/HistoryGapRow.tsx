import { useEffect, useRef } from 'react'
import type { TimelineItem } from '@slayzone/terminal/client'
import { useChatView } from './ChatViewContext'
import { gapHeight } from './virtual-timeline'

export type HistoryGap = Extract<TimelineItem, { kind: 'history-gap' }>

/** How far beyond the view a placeholder already loads (px): rows are there in time. */
const PREFETCH_PX = 800
/** A placeholder that just mounted looks where it is after this long (ms). */
const SETTLE_MS = 150

/**
 * Rows of a paged history that are not loaded here: a placeholder about as tall
 * as they will be. While it is in (or near) the view it asks for the rows at
 * the part of it in view — the top of the history when scrolled to the top,
 * the rows just above the loaded ones when scrolling up into it — and they
 * replace that part of it.
 */
export function HistoryGapRow({ item }: { item: HistoryGap }) {
  const { history } = useChatView()
  const onVisible = history?.onGapVisible
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    const scroller = el?.closest<HTMLElement>('[data-chat-scroller]')
    if (!el || !scroller || !onVisible) return
    let frame: number | null = null
    const check = (): void => {
      frame = null
      const gap = el.getBoundingClientRect()
      const view = scroller.getBoundingClientRect()
      if (gap.height <= 0) return
      const top = Math.max(gap.top, view.top - PREFETCH_PX)
      const bottom = Math.min(gap.bottom, view.bottom + PREFETCH_PX)
      if (bottom <= top) return
      // The rows at the middle of the part in view (rows spread evenly over it).
      const mid = ((top + bottom) / 2 - gap.top) / gap.height
      const row = item.from + Math.floor(Math.min(0.999, Math.max(0, mid)) * (item.to - item.from))
      onVisible(item, row)
    }
    const schedule = (): void => {
      if (frame === null) frame = requestAnimationFrame(check)
    }
    // Mounted while a view settles (a tab opening at its end) is not "in view":
    // look once it has had time to get where it is going.
    const settle = setTimeout(check, SETTLE_MS)
    scroller.addEventListener('scroll', schedule, { passive: true })
    return () => {
      clearTimeout(settle)
      scroller.removeEventListener('scroll', schedule)
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [onVisible, item])
  return (
    <div
      ref={ref}
      data-testid="chat-history-gap"
      data-gap-from={item.from}
      data-gap-to={item.to}
      className="flex items-start justify-center text-xs text-muted-foreground"
      style={{ height: gapHeight(item) }}
    >
      <span className="sticky top-2 py-2">Loading earlier messages…</span>
    </div>
  )
}
