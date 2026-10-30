import type { ReactNode } from 'react'
import type { CallbackRef } from '../useFollowBottom'

/**
 * The timeline's scroll container and content box, as `ChatTimeline` renders
 * them: the refs come in as props (never read off the controller where they
 * are attached).
 */
export function TimelineScroller({
  scrollRef,
  contentRef,
  children
}: {
  scrollRef: CallbackRef<HTMLElement>
  contentRef: CallbackRef<HTMLElement>
  children: ReactNode
}) {
  return (
    <div data-testid="chat-timeline-scroller" ref={scrollRef}>
      <div ref={contentRef}>{children}</div>
    </div>
  )
}
