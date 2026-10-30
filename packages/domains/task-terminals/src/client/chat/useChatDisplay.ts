import { useCallback, useEffect, useMemo, useState, type Key } from 'react'
import { toast, safeClipboardWriteText, useStableCallback } from '@slayzone/ui'
import type { ChatScrollAnchor } from '@slayzone/terminal-contracts'
import { streamKeyOf, type TimelineItem } from '@slayzone/terminal/client'
import { useChatSearch } from './useChatSearch'
import { isRenderable } from './renderers'
import { useVirtualTimeline } from './useVirtualTimeline'
import type { FollowBottomApi } from './useFollowBottom'

export interface UseChatDisplayOpts {
  timeline: TimelineItem[]
  finalOnly: boolean
  showLastMessageTools: boolean
  /** The timeline's follow-bottom lock (`useFollowBottom`). */
  follow: Pick<FollowBottomApi, 'scrollRef' | 'isStuck' | 'unstick' | 'restoreAnchor'>
}

/**
 * A row's key that is the same after a reload (from ids the events carry), for
 * scroll anchors (`data-anchor-key`). Null for rows only known by position.
 */
export function stableAnchorKey(item: TimelineItem): string | null {
  switch (item.kind) {
    case 'user-text':
      return item.id ? `user:${item.id}` : null
    case 'text':
    case 'thinking':
    case 'tool':
      // The streaming key (`text:<messageId>:<n>`, `tool:<id>`) is the same live
      // and on replay; rows from before streaming have no block ordinal.
      return (
        streamKeyOf(item) ??
        `${item.kind}:${item.kind === 'tool' ? item.invocation.id : item.messageId}`
      )
    case 'hook':
      return item.hookId ? `hook:${item.hookId}` : null
    case 'sub-agent':
      return `sub-agent:${item.toolUseId}`
    case 'notice':
      return item.id ? `notice:${item.id}` : null
    case 'files-changed':
      return item.id
    default:
      return null
  }
}

/**
 * A hook row whose block its tool card shows (`foldedInto`) is not shown on
 * its own — when that card is shown. Where it is not (the final-only view, a
 * sub-agent's call), the row still explains the block.
 */
function withoutFoldedHooks(items: TimelineItem[]): TimelineItem[] {
  if (!items.some((it) => it.kind === 'hook' && it.foldedInto !== undefined)) return items
  const shown = new Set(items.flatMap((it) => (it.kind === 'tool' ? [it.invocation.id] : [])))
  return items.filter(
    (it) => !(it.kind === 'hook' && it.foldedInto !== undefined && shown.has(it.foldedInto))
  )
}

/**
 * Owns the chat timeline's *display* concerns — everything that turns the raw
 * `timeline` into what the user actually sees:
 *
 *   - `displayedTimeline`: filtered view. When `finalOnly` is on, keeps user
 *     msgs + result + the last assistant text per turn (dropping thinking/tools/
 *     intermediate noise); `showLastMessageTools` preserves tools after the last
 *     user message. Always drops non-renderable items + sub-agent children
 *     (`parentToolUseId` set) so the virtualizer count matches visible DOM.
 *   - search: delegates to `useChatSearch(displayedTimeline)` (every row is
 *     searched, mounted or not), and reveals the active match.
 *   - the virtualizer (`virtual`, plan 4.1): the whole history is one scrollable
 *     list, only rows in view are mounted; reveal by key / anchor.
 *   - `itemKey`: stable per-item keys so streaming text re-renders the same node.
 *   - copy helpers for the context menu.
 */
export function useChatDisplay({
  timeline,
  finalOnly,
  showLastMessageTools,
  follow
}: UseChatDisplayOpts) {
  // When `finalOnly` is on, keep user msgs + result + the last assistant
  // text per turn. Drop thinking/tools/intermediate text/noise.
  // Always filter non-renderable items so virtualizer count matches visible DOM.
  // Also drop items with `parentToolUseId` set — those are sub-agent children,
  // rendered nested inside their parent SubAgentRow, not at the chat root.
  // When `showLastMessageTools` is on, tools after the last user message are
  // preserved so the user sees what the agent is doing right now.
  // Folds: what a rewind / fork / switch left the conversation without stays in
  // the timeline, hidden behind its `conversation-branch` divider until opened.
  const [openBranches, setOpenBranches] = useState<ReadonlySet<string>>(() => new Set())
  const folded = useMemo<ReadonlySet<number>>(() => {
    const out = new Set<number>()
    for (const it of timeline) {
      if (it.kind !== 'conversation-branch' || openBranches.has(it.id)) continue
      for (let i = it.hiddenFrom; i < it.hiddenFrom + it.hiddenCount; i++) out.add(i)
    }
    return out
  }, [timeline, openBranches])
  const toggleBranch = useStableCallback((id: string): void => {
    setOpenBranches((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  })
  const branches = useMemo(
    () => ({ isOpen: (id: string) => openBranches.has(id), toggle: toggleBranch }),
    [openBranches, toggleBranch]
  )

  const displayedTimeline = useMemo<TimelineItem[]>(() => {
    const isRoot = (item: TimelineItem): boolean => item.parentToolUseId == null
    if (!finalOnly) {
      return withoutFoldedHooks(
        timeline.filter((item, i) => !folded.has(i) && isRoot(item) && isRenderable(item))
      )
    }
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
      if (!isRoot(item) || folded.has(i)) continue
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
      } else if (
        item.kind === 'interrupted' ||
        item.kind === 'conversation-branch' ||
        item.kind === 'compaction' ||
        item.kind === 'command-output' ||
        // What the turn changed is part of its outcome.
        item.kind === 'files-changed' ||
        // Failures and notices stay visible in every view.
        item.kind === 'notice' ||
        item.kind === 'agent-problem' ||
        item.kind === 'turn-error' ||
        // A hook that blocked / failed something explains what happened; context it added doesn't.
        (item.kind === 'hook' && item.effect !== 'context')
      ) {
        flushPending()
        out.push(item)
      }
    }
    flushPending()
    return withoutFoldedHooks(out.filter(isRenderable))
  }, [timeline, finalOnly, showLastMessageTools, folded])

  const search = useChatSearch(displayedTimeline)
  const virtual = useVirtualTimeline(follow)

  // A saved scroll anchor's row (restoring a position): scroll to it, mounted
  // or not; `restoreAnchor` then puts the exact offset back once it renders.
  const revealAnchor = useStableCallback((anchorKey: string): void => {
    const at = displayedTimeline.findIndex((it) => stableAnchorKey(it) === anchorKey)
    if (at >= 0) virtual.revealIndex(at, { align: 'start' })
  })
  const restoreAnchor = useStableCallback((anchor: ChatScrollAnchor): boolean => {
    const restored = follow.restoreAnchor(anchor)
    // The exact position is set: the reveal that brought the row in stops re-aiming.
    if (restored && !anchor.atBottom) virtual.cancelReveal()
    return restored
  })

  // Stable per-item keys so streaming text updates re-render the same DOM node.
  // A streamed row keeps its key when its saved block finalizes it (plan 3.2):
  // `text|thinking:<messageId>:<n>` (n-th block of the message — two text blocks
  // of one message no longer share a key), `tool:<id>`.
  const itemKey = useCallback((item: TimelineItem, index: number): Key => {
    const streamKey = streamKeyOf(item)
    if (streamKey) return streamKey
    if (item.kind === 'text' || item.kind === 'thinking') return `${item.kind}:${item.messageId}`
    if (item.kind === 'session-start') return `session:${item.sessionId}`
    if (item.kind === 'conversation-branch') return item.id
    if (item.kind === 'user-text' && item.id) return `user-text:${item.id}`
    if (item.kind === 'result') return `result:${item.timestamp}:${index}`
    if (item.kind === 'hook' && item.hookId) return `hook:${item.hookId}`
    // By its Task call: the files-changed panel reveals a sub-agent's edits.
    if (item.kind === 'sub-agent') return `sub-agent:${item.toolUseId}`
    if (item.kind === 'notice' && item.id) return `notice:${item.id}`
    if (item.kind === 'files-changed') return item.id
    return `${item.kind}:${index}`
  }, [])

  // Scroll to the active match — wherever it is in the history.
  useEffect(() => {
    if (search.activeItemIdx < 0) return
    virtual.revealIndex(search.activeItemIdx, { align: 'center' })
  }, [search.activeItemIdx, virtual])

  const copyAllMessages = useCallback(() => {
    const text = displayedTimeline
      .map((it) => {
        switch (it.kind) {
          case 'user-text': {
            const files = (it.attachments ?? []).map((a) => `[${a.kind}: ${a.name}]`)
            return [...files, it.text]
              .filter(Boolean)
              .map((l) => `> ${l}`)
              .join('\n')
          }
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
    void safeClipboardWriteText(text)
    toast('Conversation copied')
  }, [displayedTimeline])

  const copyLastResponse = useCallback(() => {
    const last = [...displayedTimeline].reverse().find((it) => it.kind === 'text')
    if (last && last.kind === 'text') {
      void safeClipboardWriteText(last.text)
      toast('Last response copied')
    } else {
      toast('No response to copy')
    }
  }, [displayedTimeline])

  return {
    displayedTimeline,
    virtual,
    revealAnchor,
    restoreAnchor,
    itemKey,
    search,
    copyAllMessages,
    copyLastResponse,
    branches
  }
}
