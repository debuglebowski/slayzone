import { createContext, useContext } from 'react'
import type React from 'react'

/**
 * Bring the timeline row with this key (the timeline's `itemKey`) on screen.
 * The timeline provides it (it knows its pagination / virtual window); E only
 * calls it. Seam agreed with D — D's version of this file replaces this one.
 */
export type RevealTimelineItem = (key: React.Key, opts?: { align?: 'start' | 'center' }) => void

export const TimelineRevealContext = createContext<RevealTimelineItem | null>(null)

/**
 * Without a provider: scroll the rendered row (`[data-item-key]`) that is on
 * screen. It lets go of follow-bottom first (as a wheel-up would), and scrolls
 * once the frame is painted, so a row that opens meanwhile is not pushed away.
 */
const revealRendered: RevealTimelineItem = (key, opts) => {
  const value = String(key).replace(/["\\]/g, '\\$&')
  const rows = Array.from(document.querySelectorAll<HTMLElement>(`[data-item-key="${value}"]`))
  const row = rows.find((r) => r.offsetParent !== null) ?? rows[0]
  if (!row) return
  row
    .closest('[data-testid="chat-timeline-scroller"]')
    ?.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }))
  requestAnimationFrame(() =>
    requestAnimationFrame(() => row.scrollIntoView({ block: opts?.align ?? 'center' }))
  )
}

export function useRevealTimelineItem(): RevealTimelineItem {
  return useContext(TimelineRevealContext) ?? revealRendered
}
