import { createContext, useContext, type Key } from 'react'

/**
 * Scroll the chat timeline to one of its rows, by the row's `itemKey` (the same
 * key the timeline renders it with). The row need not be mounted: the timeline
 * is virtualized, so this is the only way to reach a row far from the view.
 * `align` puts the row at the top of the view (`start`, default) or centres it.
 */
export type RevealTimelineItem = (
  key: Key,
  opts?: {
    align?: 'start' | 'center'
    /** The row's index in the timeline: a paged history loads it first when it isn't here. */
    row?: number
    /**
     * A CSS selector for an element INSIDE the row (a tool card in a folded turn):
     * the view aims at it instead of the row. A row can be far taller than the
     * view, so centring the row can leave the element out of sight.
     */
    inner?: string
  }
) => void

/**
 * Outside a timeline (no provider), only a row that is rendered can be reached:
 * the row wrappers carry `data-item-key`.
 */
const revealRenderedRow: RevealTimelineItem = (key, opts) => {
  if (typeof document === 'undefined') return
  const row = document.querySelector<HTMLElement>(`[data-item-key="${CSS.escape(String(key))}"]`)
  const inner = opts?.inner ? row?.querySelector<HTMLElement>(opts.inner) : null
  ;(inner ?? row)?.scrollIntoView({ block: opts?.align ?? 'start' })
}

/** Provided by the chat panel for its timeline (`useVirtualTimeline`). */
export const TimelineRevealContext = createContext<RevealTimelineItem>(revealRenderedRow)

export function useRevealTimelineItem(): RevealTimelineItem {
  return useContext(TimelineRevealContext)
}

/** Highlights a timeline row briefly once it is on screen (it may mount after the reveal). */
export function flashRow(key: string): void {
  const selector = `[data-item-key="${key.replace(/["\\]/g, '\\$&')}"]`
  let frames = 0
  const tick = (): void => {
    const row = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(
      (el) => el.offsetParent !== null
    )
    if (row) {
      row.animate?.(
        [
          { backgroundColor: 'color-mix(in oklab, var(--color-ring) 22%, transparent)' },
          { backgroundColor: 'transparent' }
        ],
        { duration: 1400, easing: 'ease-out' }
      )
      return
    }
    if (++frames < 60) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}
