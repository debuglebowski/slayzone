/**
 * A chat tab's history, reduced the way the chat panel reduces it, read in bounded
 * pages — never the whole log in one answer (2026-11-14: one 202 MB history read
 * closed the computer's socket and stalled it). For callers that need the state or
 * a tail (`slay chat` / `slay agent` routes: status, prompts, wait, transcript,
 * follow).
 *
 * From the tab's timeline projection when it is usable: its snapshot (the reducer
 * state as of its newest event, the newest rows) plus the events saved since;
 * older rows load on demand, a page budget per answer. Otherwise (no usable
 * projection, another reducer version) from event pages, folded one at a time.
 */
import type { AgentEvent, ChatEventPage, ChatHistoryPageEvent } from '@slayzone/terminal-contracts'
import { initialState, reducer, type ChatTimelineState, type TimelineItem } from './chat-timeline'
import { decodeTimelineState, TIMELINE_PROJECTION_VERSION } from './chat-timeline-checkpoint'
import { transcriptRows, type ChatTranscriptRow } from './chat-transcript'

/** What `openTimeline` answers (the computer's `ChatTimelineOpenResult`, as this reader uses it). */
export type ChatHistoryOpen =
  | {
      kind: 'paged'
      snapshot: {
        seq: number
        epoch: number
        pageRows: number
        state: string
        summaries: unknown[]
      }
      events: ChatHistoryPageEvent[]
    }
  | { kind: 'full' }

/** What `timelinePages` answers (`TimelinePagesResult`). */
export type ChatHistoryPages =
  | {
      expired: false
      pages: Array<{ page: number; from: number; rows: TimelineItem[] }>
      omitted?: number[]
      /** Ended inside the first `omitted` page: ask again from this row. */
      next?: number
    }
  | { expired: true }

/** The chat reads the reader makes (the hub's chat ops). */
export interface ChatHistoryReads {
  openTimeline(tabId: string, version: string): Promise<unknown>
  /** `startRow`: row slices from that row (an older peer ignores it: whole pages). */
  timelinePages(
    tabId: string,
    pages: number[],
    asOfSeq: number,
    epoch: number,
    startRow?: number
  ): Promise<unknown>
  getEventPage(tabId: string, afterSeq: number): Promise<unknown>
}

/** The projection moved on (rows reordered, too old): open the history again. */
export class ChatHistoryExpired extends Error {
  constructor() {
    super('The chat history changed while it was read; read it again.')
    this.name = 'ChatHistoryExpired'
  }
}

/** A tab's reduced history; rows of older pages load on demand. */
export interface ChatHistoryView {
  /** The reduced state: rows not loaded yet are `undefined`. */
  readonly state: ChatTimelineState
  /** Seq of the newest saved event folded in (-1: none). */
  readonly lastSeq: number
  /** Load every row in `[from, to)` not loaded yet. */
  loadRows(from: number, to: number): Promise<void>
  /** Fold saved events in, in seq order (an already folded seq is skipped). */
  apply(events: readonly ChatHistoryPageEvent[]): Promise<void>
}

/** Older rows are fetched this many pages per request at most (each answer is byte-bounded too). */
const PAGES_PER_REQUEST = 32

/**
 * Open a tab's history. `full: true` skips the projection (the caller saw it
 * expire). An unknown tab reads as an empty history.
 */
export async function openChatHistory(
  reads: ChatHistoryReads,
  tabId: string,
  opts: { agentStartedTurns: boolean; full?: boolean }
): Promise<ChatHistoryView> {
  const opened = opts.full
    ? ({ kind: 'full' } as const)
    : ((await reads.openTimeline(tabId, TIMELINE_PROJECTION_VERSION)) as ChatHistoryOpen)
  let state: ChatTimelineState =
    opened.kind === 'paged'
      ? decodeTimelineState(opened.snapshot.state)
      : initialState({ agentStartedTurns: opts.agentStartedTurns })
  let lastSeq = opened.kind === 'paged' ? opened.snapshot.seq : -1
  const pageRows = opened.kind === 'paged' ? opened.snapshot.pageRows : 0
  const sealed = opened.kind === 'paged' ? opened.snapshot.summaries.length : 0

  async function loadPages(pages: number[]): Promise<void> {
    // Asked from a row: a page larger than an answer's budget comes in row slices.
    let startRow = (pages[0] ?? 0) * pageRows
    for (let at = 0; at < pages.length; ) {
      const wanted = pages.slice(at, at + PAGES_PER_REQUEST)
      const got = (await reads.timelinePages(
        tabId,
        wanted,
        state.appliedSeq,
        state.rowsEpoch,
        startRow
      )) as ChatHistoryPages
      if (got.expired) throw new ChatHistoryExpired()
      if (got.pages.length === 0 || got.pages.every((p) => p.rows.length === 0))
        throw new ChatHistoryExpired()
      for (const page of got.pages)
        state = reducer(state, {
          type: 'rows-loaded',
          from: page.from,
          rows: page.rows,
          epoch: state.rowsEpoch
        })
      // What did not fit in the answer is asked for again: a page cut short from
      // the row it stopped at (`next`), the others whole.
      const cut = got.next !== undefined ? Math.floor(got.next / pageRows) : null
      at += got.pages.length - (cut !== null && got.pages.at(-1)?.page === cut ? 1 : 0)
      startRow = cut !== null && pages[at] === cut ? got.next! : (pages[at] ?? 0) * pageRows
    }
  }

  /** A stalled reducer waits for one row: load its page, then it goes on (maybe stalling again). */
  async function settle(): Promise<void> {
    for (let guard = 0; state.stalled; guard++) {
      if (guard > sealed + 1) throw new ChatHistoryExpired()
      await loadPages([Math.floor(state.stalled.need / pageRows)])
    }
  }

  async function apply(events: readonly ChatHistoryPageEvent[]): Promise<void> {
    const fresh = events.filter((e) => e.seq > lastSeq)
    if (fresh.length === 0) return
    state = reducer(state, {
      type: 'events',
      events: fresh.map((e) => e.event as AgentEvent),
      at: fresh.map((e) => e.at),
      seq: fresh.map((e) => e.seq)
    })
    lastSeq = fresh[fresh.length - 1].seq
    await settle()
  }

  if (opened.kind === 'paged') await apply(opened.events)
  else
    for (let from = -1; ; ) {
      const page = (await reads.getEventPage(tabId, from)) as ChatEventPage
      await apply(page.events)
      const last = page.events.at(-1)
      if (!page.hasMore || !last) break
      from = last.seq
    }

  return {
    get state() {
      return state
    },
    get lastSeq() {
      return lastSeq
    },
    apply,
    async loadRows(from, to) {
      if (pageRows === 0) return
      const end = Math.min(to, sealed * pageRows)
      const pages: number[] = []
      for (let page = Math.max(0, Math.floor(from / pageRows)); page * pageRows < end; page++) {
        for (let row = page * pageRows; row < (page + 1) * pageRows; row++)
          if (state.timeline[row] === undefined) {
            pages.push(page)
            break
          }
      }
      await loadPages(pages)
    }
  }
}

/** The history of a tab its computer does not know (no session): empty; events fold in as usual. */
export function emptyChatHistory(opts: { agentStartedTurns: boolean }): Promise<ChatHistoryView> {
  const none = async () => {
    throw new Error('An empty chat history has nothing to read')
  }
  return openChatHistory(
    {
      openTimeline: none,
      timelinePages: none,
      getEventPage: async () => ({ events: [], hasMore: false }) satisfies ChatEventPage
    },
    '',
    { ...opts, full: true }
  )
}

/**
 * `use` over a tab's opened history; an answer the projection could no longer
 * serve (it moved on meanwhile) opens it again, the last time from event pages.
 */
export async function withChatHistory<T>(
  reads: ChatHistoryReads,
  tabId: string,
  opts: { agentStartedTurns: boolean },
  use: (view: ChatHistoryView) => Promise<T>
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await use(await openChatHistory(reads, tabId, { ...opts, full: attempt >= 2 }))
    } catch (err) {
      if (!(err instanceof ChatHistoryExpired) || attempt >= 2) throw err
    }
  }
}

/**
 * The transcript rows `transcriptRows` would give over the whole history, loading
 * only the rows they come from: with `last`, pages from the end until it has
 * enough (a `conversation-branch` folds only rows before it, so the newest rows
 * are complete as soon as they are loaded).
 */
export async function chatHistoryTranscript(
  view: ChatHistoryView,
  opts: { since?: number; last?: number; verbose?: boolean }
): Promise<ChatTranscriptRow[]> {
  const length = view.state.timeline.length
  const lower = opts.since !== undefined ? Math.max(0, opts.since + 1) : 0
  if (opts.last === undefined || opts.last < 0) {
    await view.loadRows(lower, length)
    return transcriptRows(view.state, opts)
  }
  // The newest rows that are loaded already (the snapshot's tail).
  let from = length
  while (from > 0 && view.state.timeline[from - 1] !== undefined) from--
  for (let step = 256; ; step *= 2) {
    await view.loadRows(from, length)
    const rows = transcriptRows(view.state, { since: opts.since, verbose: opts.verbose }).filter(
      (r) => r.row >= from
    )
    if (rows.length >= opts.last || from <= lower)
      return rows.slice(Math.max(0, rows.length - opts.last))
    from = Math.max(lower, from - step)
  }
}

/** A message's delivery as its row records it — or, taken back by Stop, as kept (null: no state recorded beyond queued). */
export async function chatHistoryDelivery(
  view: ChatHistoryView,
  messageId: string
): Promise<{ state: string; error?: string } | null> {
  const rows = view.state.userIndex.get(messageId)
  if (!rows || rows.length === 0) {
    // Taken back by Stop: its row is gone, its delivery kept.
    const taken = view.state.takenBack.get(messageId)
    if (!taken || taken.delivery === 'queued') return null
    return { state: taken.delivery, ...(taken.error ? { error: taken.error } : {}) }
  }
  const at = rows[rows.length - 1]
  await view.loadRows(at, at + 1)
  const item = view.state.timeline[at]
  if (!item || item.kind !== 'user-text' || !item.delivery || item.delivery === 'queued')
    return null
  return { state: item.delivery, ...(item.deliveryError ? { error: item.deliveryError } : {}) }
}
