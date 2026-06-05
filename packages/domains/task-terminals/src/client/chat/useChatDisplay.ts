import { useCallback, useEffect, useMemo, useState, type Key } from 'react'
import { toast } from '@slayzone/ui'
import type { TimelineItem } from '@slayzone/terminal/client'
import { useChatSearch } from './useChatSearch'
import { isRenderable } from './renderers'
import type { CallbackRef } from './useFollowBottom'

export interface UseChatDisplayOpts {
  timeline: TimelineItem[]
  finalOnly: boolean
  showLastMessageTools: boolean
  scrollRef: CallbackRef<HTMLElement>
}

// Paginate older items: show last `visibleCount`, expose "Show more" at top.
const PAGE_SIZE = 100

/**
 * Owns the chat timeline's *display* concerns — everything that turns the raw
 * `timeline` into what the user actually sees:
 *
 *   - `displayedTimeline`: filtered view. When `finalOnly` is on, keeps user
 *     msgs + result + the last assistant text per turn (dropping thinking/tools/
 *     intermediate noise); `showLastMessageTools` preserves tools after the last
 *     user message. Always drops non-renderable items + sub-agent children
 *     (`parentToolUseId` set) so the virtualizer count matches visible DOM.
 *   - search: delegates to `useChatSearch(displayedTimeline)`, plus the two
 *     effects that keep the active match on-screen (auto-expand the pagination
 *     window above it; scroll it into view).
 *   - pagination: `visibleCount` window + derived slice.
 *   - `itemKey`: stable per-item keys so streaming text re-renders the same node.
 *   - copy helpers for the context menu.
 */
export function useChatDisplay({
  timeline,
  finalOnly,
  showLastMessageTools,
  scrollRef
}: UseChatDisplayOpts) {
  // When `finalOnly` is on, keep user msgs + result + the last assistant
  // text per turn. Drop thinking/tools/intermediate text/noise.
  // Always filter non-renderable items so virtualizer count matches visible DOM.
  // Also drop items with `parentToolUseId` set — those are sub-agent children,
  // rendered nested inside their parent SubAgentRow, not at the chat root.
  // When `showLastMessageTools` is on, tools after the last user message are
  // preserved so the user sees what the agent is doing right now.
  const displayedTimeline = useMemo<TimelineItem[]>(() => {
    const isRoot = (item: TimelineItem): boolean => item.parentToolUseId == null
    if (!finalOnly) return timeline.filter((item) => isRoot(item) && isRenderable(item))
    let lastUserIdx = -1
    if (showLastMessageTools) {
      for (let i = timeline.length - 1; i >= 0; i--) {
        if (isRoot(timeline[i]) && timeline[i].kind === 'user-text') {
          lastUserIdx = i
          break
        }
      }
    }
    const out: TimelineItem[] = []
    let pendingFinal: TimelineItem | null = null
    const flushPending = (): void => {
      if (pendingFinal) {
        out.push(pendingFinal)
        pendingFinal = null
      }
    }
    for (let i = 0; i < timeline.length; i++) {
      const item = timeline[i]
      if (!isRoot(item)) continue
      if (item.kind === 'user-text') {
        flushPending()
        out.push(item)
      } else if (item.kind === 'text' && item.role === 'assistant') {
        pendingFinal = item
      } else if (
        item.kind === 'tool' &&
        (item.invocation.name === 'ExitPlanMode' || item.invocation.name === 'AskUserQuestion')
      ) {
        flushPending()
        out.push(item)
      } else if (item.kind === 'tool' && showLastMessageTools && i > lastUserIdx) {
        flushPending()
        out.push(item)
      } else if (item.kind === 'sub-agent' && showLastMessageTools && i > lastUserIdx) {
        flushPending()
        out.push(item)
      } else if (item.kind === 'thinking' && showLastMessageTools && i > lastUserIdx) {
        flushPending()
        out.push(item)
      } else if (item.kind === 'result') {
        flushPending()
        out.push(item)
      } else if (item.kind === 'interrupted') {
        flushPending()
        out.push(item)
      }
    }
    flushPending()
    return out.filter(isRenderable)
  }, [timeline, finalOnly, showLastMessageTools])

  const search = useChatSearch(displayedTimeline)

  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const hiddenCount = Math.max(0, displayedTimeline.length - visibleCount)
  const visibleStart = displayedTimeline.length - Math.min(visibleCount, displayedTimeline.length)
  const visibleItems = displayedTimeline.slice(visibleStart)

  // Auto-expand window if a search match lands above it.
  useEffect(() => {
    if (search.activeItemIdx < 0) return
    if (search.activeItemIdx < visibleStart) {
      setVisibleCount(displayedTimeline.length - search.activeItemIdx)
    }
  }, [search.activeItemIdx, visibleStart, displayedTimeline.length])

  // Stable per-item keys so streaming text updates re-render the same DOM node.
  const itemKey = useCallback((item: TimelineItem, index: number): Key => {
    if (item.kind === 'text' || item.kind === 'thinking') return `${item.kind}:${item.messageId}`
    if (item.kind === 'tool') return `tool:${item.invocation.id}`
    if (item.kind === 'session-start') return `session:${item.sessionId}`
    if (item.kind === 'result') return `result:${item.timestamp}:${index}`
    return `${item.kind}:${index}`
  }, [])

  // Scroll to the active match.
  useEffect(() => {
    if (search.activeItemIdx < 0) return
    const el = scrollRef.current?.querySelector<HTMLElement>(
      `[data-index="${search.activeItemIdx}"]`
    )
    el?.scrollIntoView({ block: 'center' })
  }, [search.activeItemIdx, scrollRef])

  const copyAllMessages = useCallback(() => {
    const text = displayedTimeline
      .map((it) => {
        switch (it.kind) {
          case 'user-text':
            return `> ${it.text}`
          case 'text':
            return it.text
          case 'thinking':
            return `[thinking] ${it.text}`
          case 'result':
            return it.text ?? ''
          case 'tool':
            return `[tool: ${it.invocation.name}]`
          default:
            return ''
        }
      })
      .filter(Boolean)
      .join('\n\n')
    void navigator.clipboard.writeText(text)
    toast('Conversation copied')
  }, [displayedTimeline])

  const copyLastResponse = useCallback(() => {
    const last = [...displayedTimeline].reverse().find((it) => it.kind === 'text')
    if (last && last.kind === 'text') {
      void navigator.clipboard.writeText(last.text)
      toast('Last response copied')
    } else {
      toast('No response to copy')
    }
  }, [displayedTimeline])

  return {
    displayedTimeline,
    visibleItems,
    visibleStart,
    hiddenCount,
    PAGE_SIZE,
    setVisibleCount,
    itemKey,
    search,
    copyAllMessages,
    copyLastResponse
  }
}
