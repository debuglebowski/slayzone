import { createContext, useContext, type Key } from 'react'

/**
 * Scroll the chat timeline to one of its rows, by the row's `itemKey` (the same
 * key the timeline renders it with). The row need not be mounted: the timeline
 * is virtualized, so this is the only way to reach a row far from the view.
 * `align` puts the row at the top of the view (`start`, default) or centres it.
 */
export type RevealTimelineItem = (key: Key, opts?: { align?: 'start' | 'center' }) => void

/**
 * Outside a timeline (no provider), only a row that is rendered can be reached:
 * the row wrappers carry `data-item-key`.
 */
const revealRenderedRow: RevealTimelineItem = (key, opts) => {
  if (typeof document === 'undefined') return
  const row = document.querySelector<HTMLElement>(`[data-item-key="${CSS.escape(String(key))}"]`)
  row?.scrollIntoView({ block: opts?.align ?? 'start' })
}

/** Provided by the chat panel for its timeline (`useVirtualTimeline`). */
export const TimelineRevealContext = createContext<RevealTimelineItem>(revealRenderedRow)

export function useRevealTimelineItem(): RevealTimelineItem {
  return useContext(TimelineRevealContext)
}
