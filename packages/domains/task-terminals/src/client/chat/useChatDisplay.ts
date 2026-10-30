import { useCallback, useEffect, useMemo, useRef, useState, type Key } from 'react'
import { toast, safeClipboardWriteText, useStableCallback } from '@slayzone/ui'
import type { ChatScrollAnchor } from '@slayzone/terminal-contracts'
import {
  streamKeyOf,
  type ChatPaging,
  type TimelineItem,
  type TimelinePageSummary,
  type TimelineRows
} from '@slayzone/terminal/client'
import type { HistoryGap } from './HistoryGapRow'
import { historySummary } from './history-summary'
import type { RevealTimelineItem } from './timeline-reveal'
import { useChatSearch } from './useChatSearch'
import { isRenderable } from './renderers'
import { useVirtualTimeline } from './useVirtualTimeline'
import type { FollowBottomApi } from './useFollowBottom'

export interface UseChatDisplayOpts {
  /** The rows (`undefined`: not loaded here — not shown). */
  timeline: Readonly<TimelineRows>
  finalOnly: boolean
  showLastMessageTools: boolean
  /** The timeline's follow-bottom lock (`useFollowBottom`). */
  follow: Pick<FollowBottomApi, 'scrollRef' | 'isStuck' | 'unstick' | 'restoreAnchor'>
  /** Paged history (`useChatSession`): page summaries, and loading pages. */
  paging?: ChatPaging | null
  loadPages?: (pages: readonly number[]) => void
  /** Pages that may hold a search query (loaded, so the search sees their rows). */
  searchPages?: (query: string) => Promise<number[]>
  /** The whole history's summary (`historySummary`), when the caller has it already. */
  summary?: TimelinePageSummary
  /** Drop pages' rows from memory (paged history: what is far from the view). */
  unloadPages?: (pages: readonly number[]) => void
}

/** Pages of a paged history kept loaded besides the tail, at most (~6,000 rows). */
const MAX_LOADED_PAGES = 24

/** Typing settles this long before a search asks the hub for pages. */
const SEARCH_PAGES_DELAY_MS = 150

/**
 * A displayed row's key: from ids it carries, else by its index in the
 * timeline (`row`) — never its display position, which shifts as rows load.
 */
function itemKeyOf(item: TimelineItem, row: number): Key {
  const streamKey = streamKeyOf(item)
  if (streamKey) return streamKey
  if (item.kind === 'text' || item.kind === 'thinking') return `${item.kind}:${item.messageId}`
  if (item.kind === 'session-start') return `session:${item.sessionId}`
  if (item.kind === 'conversation-branch') return item.id
  if (item.kind === 'user-text' && item.id) return `user-text:${item.id}`
  if (item.kind === 'result') return `result:${item.timestamp}:${row}`
  if (item.kind === 'hook' && item.hookId) return `hook:${item.hookId}`
  // By its Task call: the files-changed panel reveals a sub-agent's edits.
  if (item.kind === 'sub-agent') return `sub-agent:${item.toolUseId}`
  if (item.kind === 'notice' && item.id) return `notice:${item.id}`
  if (item.kind === 'files-changed') return item.id
  // Its range: loading part of it makes it another placeholder.
  if (item.kind === 'history-gap') return `gap:${item.from}-${item.to}`
  return `${item.kind}:${row}`
}

/** Pages a row run `from`..`to` touches. */
function pagesOf(from: number, to: number, pageRows: number): number[] {
  const out: number[] = []
  for (let p = Math.floor(from / pageRows); p * pageRows < to; p++) out.push(p)
  return out
}

/**
 * Every `conversation-branch` item of the conversation: the loaded ones, and
 * from the summaries those of pages not loaded (folds hide rows by index).
 */
export function knownBranches(
  timeline: Readonly<TimelineRows>,
  paging: ChatPaging | null | undefined
): Array<Extract<TimelineItem, { kind: 'conversation-branch' }>> {
  const out: Array<Extract<TimelineItem, { kind: 'conversation-branch' }>> = []
  const seen = new Set<number>()
  timeline.forEach((it, i) => {
    if (it?.kind !== 'conversation-branch') return
    out.push(it)
    seen.add(i)
  })
  for (const summary of paging?.summaries ?? []) {
    for (const b of summary.branches) {
      if (!seen.has(b.row) && timeline[b.row] === undefined) out.push(b.item)
    }
  }
  return out
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

/** A gap unless every row of it is folded away (those never show). */
function visibleGap(gap: HistoryGap, folded: ReadonlySet<number>): boolean {
  for (let i = gap.from; i < gap.to; i++) if (!folded.has(i)) return true
  return false
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
  follow,
  paging,
  loadPages,
  searchPages,
  summary: givenSummary,
  unloadPages
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
    for (const it of knownBranches(timeline, paging)) {
      if (openBranches.has(it.id)) continue
      for (let i = it.hiddenFrom; i < it.hiddenFrom + it.hiddenCount; i++) out.add(i)
    }
    return out
  }, [timeline, openBranches, paging])

  // Rows not loaded here (paged history) show as one placeholder per run of
  // them, about as tall as the rows they stand for.
  const gapAt = useCallback(
    (from: number): HistoryGap => {
      let to = from
      while (to < timeline.length && timeline[to] === undefined) to++
      let rows = 0
      if (paging) {
        for (const p of pagesOf(from, to, paging.pageRows)) {
          const overlap =
            Math.min(to, (p + 1) * paging.pageRows) - Math.max(from, p * paging.pageRows)
          rows += ((paging.summaries[p]?.rootRows ?? paging.pageRows) * overlap) / paging.pageRows
        }
      } else {
        rows = to - from
      }
      return { kind: 'history-gap', from, to, rows, timestamp: 0 }
    },
    [timeline, paging]
  )
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
      const out: TimelineItem[] = []
      for (let i = 0; i < timeline.length; i++) {
        const item = timeline[i]
        if (item === undefined) {
          const gap = gapAt(i)
          if (visibleGap(gap, folded)) out.push(gap)
          i = gap.to - 1
          continue
        }
        if (!folded.has(i) && isRoot(item) && isRenderable(item)) out.push(item)
      }
      return withoutFoldedHooks(out)
    }
    let lastUserIdx = -1
    if (showLastMessageTools) {
      for (let i = timeline.length - 1; i >= 0; i--) {
        const it = timeline[i]
        if (it && isRoot(it) && it.kind === 'user-text') {
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
      if (item === undefined) {
        const gap = gapAt(i)
        if (visibleGap(gap, folded)) {
          flushPending()
          out.push(gap)
        }
        i = gap.to - 1
        continue
      }
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
  }, [timeline, finalOnly, showLastMessageTools, folded, gapAt])

  // Each displayed row's index in the timeline: keys stay the same when rows
  // load above them (a key by display position would shift).
  const rowOf = useMemo(() => {
    const out = new Map<TimelineItem, number>()
    timeline.forEach((it, i) => {
      if (it) out.set(it, i)
    })
    return out
  }, [timeline])

  // A placeholder is in view at `row`: load that page and its neighbours in it.
  // Rows a component needs (a sub-agent's children): their pages load.
  const loadRows = useStableCallback((rows: readonly number[]): void => {
    if (!paging || !loadPages) return
    loadPages([...new Set(rows.map((r) => Math.floor(r / paging.pageRows)))])
  })
  const onGapVisible = useStableCallback((gap: HistoryGap, row: number): void => {
    // At the end, following it, a placeholder is never really in view (the
    // tail is over a page of rows). Away from the end it loads, followed or not
    // (a scrollbar drag moves the view without letting go of the end).
    if (!paging || !loadPages) return
    const el = follow.scrollRef.current
    if (follow.isStuck() && el && el.scrollHeight - el.scrollTop - el.clientHeight <= 2) return
    const at = Math.floor(row / paging.pageRows)
    const inGap = new Set(pagesOf(gap.from, gap.to, paging.pageRows))
    loadPages([at, at - 1, at + 1].filter((p) => inGap.has(p)))
  })
  const history = useMemo(() => ({ onGapVisible, loadRows }), [onGapVisible, loadRows])

  // Pages a feature holds (search hits while searching, copy-all, the files
  // panel): never dropped while held.
  const [pins, setPins] = useState<ReadonlyMap<string, readonly number[]>>(() => new Map())
  const pinPages = useStableCallback((reason: string, pages: readonly number[] | null): void => {
    setPins((prev) => {
      if (pages === null && !prev.has(reason)) return prev
      const next = new Map(prev)
      if (pages === null) next.delete(reason)
      else next.set(reason, pages)
      return next
    })
  })
  const search = useChatSearch(displayedTimeline)
  // Paged history: the pages that may hold the query load, so the search
  // counts and reaches matches in the whole history, not just what is loaded.
  const searchQuery = search.query
  useEffect(() => {
    if (!paging || !loadPages || !searchPages || !searchQuery) return
    const timer = setTimeout(() => {
      void searchPages(searchQuery).then((pages) => {
        pinPages('search', pages)
        loadPages(pages)
      })
    }, SEARCH_PAGES_DELAY_MS)
    return () => clearTimeout(timer)
  }, [searchQuery, paging, loadPages, searchPages, pinPages])
  useEffect(() => {
    if (!searchQuery) pinPages('search', null)
  }, [searchQuery, pinPages])
  const virtual = useVirtualTimeline(follow)

  // A saved scroll anchor's row (restoring a position): scroll to it, mounted
  // or not; `restoreAnchor` then puts the exact offset back once it renders. Not
  // loaded (paged history): its page (`row`) loads, then it is revealed.
  // (A ref: set by the handler, read + cleared when rows come in.)
  const pendingAnchorRef = useRef<string | null>(null)
  const revealAnchor = useStableCallback((anchorKey: string, row?: number): void => {
    const at = displayedTimeline.findIndex((it) => stableAnchorKey(it) === anchorKey)
    if (at >= 0) {
      virtual.revealIndex(at, { align: 'start' })
      return
    }
    if (row === undefined || !paging || !loadPages) return
    pendingAnchorRef.current = anchorKey
    loadPages([Math.floor(row / paging.pageRows)])
  })
  useEffect(() => {
    const pending = pendingAnchorRef.current
    if (pending === null) return
    const at = displayedTimeline.findIndex((it) => stableAnchorKey(it) === pending)
    if (at < 0) return
    pendingAnchorRef.current = null
    virtual.revealIndex(at, { align: 'start' })
  }, [displayedTimeline, virtual])
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
  const itemKey = useCallback(
    (item: TimelineItem, index: number): Key => itemKeyOf(item, rowOf.get(item) ?? index),
    [rowOf]
  )

  // Scroll to the active match — wherever it is in the history.
  useEffect(() => {
    if (search.activeItemIdx < 0) return
    virtual.revealIndex(search.activeItemIdx, { align: 'center' })
  }, [search.activeItemIdx, virtual])

  const copyNow = useCallback(() => {
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
  // Paged history: the whole conversation loads first (held while it does).
  const hasUnloaded = useMemo(() => timeline.some((row) => row === undefined), [timeline])
  const copyPendingRef = useRef(false)
  const copyAllMessages = useStableCallback((): void => {
    if (!paging || !loadPages || !hasUnloaded) {
      copyNow()
      return
    }
    const all = Array.from({ length: paging.sealed }, (_, p) => p)
    pinPages('copy-all', all)
    loadPages(all)
    copyPendingRef.current = true
    toast('Loading the whole conversation to copy it…')
  })
  useEffect(() => {
    if (!copyPendingRef.current || hasUnloaded) return
    copyPendingRef.current = false
    pinPages('copy-all', null)
    copyNow()
  }, [hasUnloaded, pinPages, copyNow])

  const copyLastResponse = useCallback(() => {
    const last = [...displayedTimeline].reverse().find((it) => it.kind === 'text')
    if (last && last.kind === 'text') {
      void safeClipboardWriteText(last.text)
      toast('Last response copied')
    } else {
      toast('No response to copy')
    }
  }, [displayedTimeline])

  // (Stable per timeline: rows' `data-row`.)
  const rowOfItem = useCallback((item: TimelineItem) => rowOf.get(item), [rowOf])

  // The whole history's summary (rows here + the hub's for pages not loaded):
  // what the outline, rewind, files count and budget read.
  const ownSummary = useMemo(
    () => givenSummary ?? historySummary(timeline, paging),
    [givenSummary, timeline, paging]
  )
  const summary = ownSummary
  // What the conversation no longer holds — every fold, opened in the UI or not
  // (what edit / rewind / fork and the files count go by).
  const conversationFolded = useMemo<ReadonlySet<number>>(() => {
    const out = new Set<number>()
    for (const b of summary.branches) {
      for (let i = b.item.hiddenFrom; i < b.item.hiddenFrom + b.item.hiddenCount; i++) out.add(i)
    }
    return out
  }, [summary])

  // Reveal a row by its key — not here (paged history): its page (`row`) loads,
  // then it is revealed.
  const pendingRevealRef = useRef<{ key: Key; align: 'start' | 'center' } | null>(null)
  const revealItem = useStableCallback<Parameters<RevealTimelineItem>, void>((key, opts) => {
    const align = opts?.align ?? 'start'
    if (displayedTimeline.some((it, i) => itemKey(it, i) === key)) {
      virtual.revealKey(key, { align })
      return
    }
    if (opts?.row === undefined || !paging || !loadPages) return
    pendingRevealRef.current = { key, align }
    loadPages([Math.floor(opts.row / paging.pageRows)])
  })
  // Memory holds what is near the view: past the budget, the loaded pages
  // farthest from it go (any the reducer or the view needs again load again).
  useEffect(() => {
    if (!paging || !unloadPages) return
    const loaded: number[] = []
    for (let p = 0; p < paging.sealed; p++) {
      if (timeline[p * paging.pageRows] !== undefined) loaded.push(p)
    }
    if (loaded.length <= MAX_LOADED_PAGES) return
    const held = new Set<number>()
    for (const pages of pins.values()) for (const p of pages) held.add(p)
    const top = displayedTimeline[Math.max(0, virtual.topIndex())]
    const topRow = top ? (rowOf.get(top) ?? (top.kind === 'history-gap' ? top.from : 0)) : 0
    const viewPage = Math.floor(topRow / paging.pageRows)
    const drop = loaded
      .filter((p) => !held.has(p))
      .sort((a, b) => Math.abs(b - viewPage) - Math.abs(a - viewPage))
      .slice(0, loaded.length - MAX_LOADED_PAGES)
    if (drop.length > 0) unloadPages(drop)
  }, [timeline, paging, unloadPages, pins, displayedTimeline, rowOf, virtual])
  useEffect(() => {
    const pending = pendingRevealRef.current
    if (pending === null) return
    if (!displayedTimeline.some((it, i) => itemKey(it, i) === pending.key)) return
    pendingRevealRef.current = null
    virtual.revealKey(pending.key, { align: pending.align })
  }, [displayedTimeline, itemKey, virtual])

  return {
    displayedTimeline,
    history,
    rowOf: rowOfItem,
    summary,
    folded,
    conversationFolded,
    revealItem,
    pinPages,
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
