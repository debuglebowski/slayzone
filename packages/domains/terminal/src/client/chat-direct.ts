/**
 * A chat tab's history reads over the direct link when the tab has one
 * (docs/direct-link.md), with the hub's types and the hub as the fallback: a direct
 * read that fails is answered by the hub, and the link is reported lost. The
 * computer returns exactly what the hub would relay, so its answers carry the hub's
 * output types.
 *
 * Permission and tool answers always go through the hub: its relay refuses them
 * while the conversation runs in the terminal, and syncs the chat's bootstrap first
 * — checks only the hub can make.
 *
 * @module terminal/client/chat-direct
 */
import {
  isChatReplayPage,
  type ChatHistoryPageEvent,
  type ChatHistoryDisplay,
  type CHAT_HISTORY_DISPLAY_VERSION,
  type ChatRowDetailRef
} from '@slayzone/terminal-contracts'
import { noteDirectUse, type DirectLease } from '@slayzone/transport/direct-client'
import {
  decodeTimelineState,
  TIMELINE_PROJECTION_VERSION
} from '../shared/chat-timeline-checkpoint'
import type { TimelineRows } from '../shared/timeline-rows'
import type { ChatTimelineState } from '../shared/chat-timeline'
import type { ChatOpenTimer } from '../shared/chat-open-timing'
import type { TimelinePageSummary } from '../shared/timeline-summary'

type Query<I, O> = { query(input: I): Promise<O> }
type Mutation<I, O> = { mutate(input: I): Promise<O> }

/** The hub chat procedures this module routes (inputs as the hub takes them). */
export interface ChatHubSlice {
  chat: {
    openTimeline: Query<
      { tabId: string; version: string; toolPreviews?: boolean; display?: ChatHistoryDisplay },
      unknown
    >
    toolDetail: Query<
      {
        tabId: string
        detail: ChatRowDetailRef
        offset: number
        revision?: string
      },
      unknown
    >
    /** With `page`: one bounded page (an older peer answers the whole replay instead). */
    getReplay: Query<
      { tabId: string; afterSeq: number; page?: { maxBytes?: number; maxEvents?: number } },
      unknown
    >
    readBlob: Query<{ tabId: string; sha256: string; offset: number }, unknown>
    /** With `startRow`: row slices (`next`); an older peer answers whole pages. */
    timelinePages: Query<
      {
        tabId: string
        pages: number[]
        asOfSeq: number
        epoch: number
        startRow?: number
        toolPreviews?: boolean
        display?: ChatHistoryDisplay
      },
      unknown
    >
    searchTimeline: Query<{ tabId: string; query: string; caseSensitive?: boolean }, unknown>
    respondPermission: Mutation<{ tabId: string; args: never }, unknown>
    sendToolResult: Mutation<{ tabId: string; args: never }, unknown>
  }
}

type In<P> = P extends { query(input: infer I): unknown }
  ? I
  : P extends { mutate(input: infer I): unknown }
    ? I
    : never
type Out<P> = P extends { query(input: never): Promise<infer O> }
  ? O
  : P extends { mutate(input: never): Promise<infer O> }
    ? O
    : never

/** What went direct since load (diagnostics, e2e). */
const stats = { reads: 0, events: 0 }
const linkedTabs = new Set<string>()

/** Tabs on the direct link now, and what went direct (diagnostics, e2e). */
export function directChatStatus(): {
  tabIds: string[]
  reads: number
  events: number
} {
  return { tabIds: [...linkedTabs], ...stats }
}

/** A tab's direct link came up (true) or went (false). */
export function noteDirectChatLink(tabId: string, linked: boolean): void {
  if (linked) linkedTabs.add(tabId)
  else linkedTabs.delete(tabId)
  noteDirectUse('chat', tabId, linked)
}

/** One event arrived over the direct link. */
export function noteDirectChatEvent(): void {
  stats.events++
}

if (typeof window !== 'undefined') {
  ;(window as unknown as { __slayzone_directChat?: () => unknown }).__slayzone_directChat =
    directChatStatus
}

export function chatViaDirect<H extends ChatHubSlice>(
  hub: H,
  direct: DirectLease['client'] | null,
  lost: () => void,
  canReadDetailViaHub?: (withDisplay?: boolean) => Promise<boolean>
) {
  type C = H['chat']
  async function read<
    K extends
      | 'openTimeline'
      | 'getReplay'
      | 'readBlob'
      | 'timelinePages'
      | 'searchTimeline'
      | 'toolDetail'
  >(name: K, input: In<C[K]>): Promise<Out<C[K]>> {
    const viaHub = () => (hub.chat[name] as unknown as Query<In<C[K]>, Out<C[K]>>).query(input)
    if (!direct) return viaHub()
    try {
      const out = (await (direct.chat[name] as unknown as Query<In<C[K]>, Out<C[K]>>).query(
        input
      )) as Out<C[K]>
      stats.reads++
      return out
    } catch {
      lost()
      return viaHub()
    }
  }
  return {
    openTimeline: async (input: In<C['openTimeline']>) => {
      if (input.toolPreviews && direct) {
        // A direct snapshot must still be expandable after falling back to the hub.
        const plain = { ...input }
        delete plain.display
        if (!(await canReadDetailViaHub?.())) {
          return read('openTimeline', { ...plain, toolPreviews: false })
        }
        if (input.display && !(await canReadDetailViaHub?.(true))) {
          return read('openTimeline', plain)
        }
      }
      return read('openTimeline', input)
    },
    getReplay: (input: In<C['getReplay']>) => read('getReplay', input),
    readBlob: (input: In<C['readBlob']>) => read('readBlob', input),
    timelinePages: async (input: In<C['timelinePages']>) => {
      if (input.display && direct && !(await canReadDetailViaHub?.(true))) {
        const plain = { ...input }
        delete plain.display
        return read('timelinePages', plain)
      }
      return read('timelinePages', input)
    },
    toolDetail: (input: In<C['toolDetail']>) => read('toolDetail', input),
    searchTimeline: (input: In<C['searchTimeline']>) => read('searchTimeline', input),
    respondPermission: (input: In<C['respondPermission']>) =>
      (
        hub.chat.respondPermission as unknown as Mutation<
          In<C['respondPermission']>,
          Out<C['respondPermission']>
        >
      ).mutate(input),
    sendToolResult: (input: In<C['sendToolResult']>) =>
      (
        hub.chat.sendToolResult as unknown as Mutation<
          In<C['sendToolResult']>,
          Out<C['sendToolResult']>
        >
      ).mutate(input)
  }
}

/** A whole replay: saved events after a seq, and what streams right now. */
export interface WholeChatReplay {
  events: ChatHistoryPageEvent[]
  live: { afterSeq: number; liveSeq: number; events: unknown[] }
}

/**
 * A tab's replay after `afterSeq`, one bounded page per read (2026-11-14: one
 * whole-history answer closed the computer's socket). An older hub or computer
 * answers the whole replay at once (no `hasMore`): that is the last page. Null:
 * `stale` went true between reads.
 */
export async function readReplayPages(
  io: {
    getReplay(input: {
      tabId: string
      afterSeq: number
      page: { maxBytes?: number; maxEvents?: number }
    }): Promise<unknown>
  },
  tabId: string,
  afterSeq: number,
  stale: () => boolean = () => false
): Promise<WholeChatReplay | null> {
  const events: ChatHistoryPageEvent[] = []
  for (let from = afterSeq; ; ) {
    const answer = await io.getReplay({ tabId, afterSeq: from, page: {} })
    if (stale()) return null
    if (!isChatReplayPage(answer)) {
      const whole = answer as WholeChatReplay
      return { events: [...events, ...whole.events], live: whole.live }
    }
    events.push(...answer.events)
    if (!answer.hasMore) return { events, live: answer.live }
    const last = answer.events.at(-1)
    if (!last) throw new Error('Chat history page was empty but not the last one')
    from = last.seq
  }
}

/** What `chat.openTimeline` answers (see the transport's `ChatTimelineOpenResult`). */
interface OpenedPaged {
  kind: 'paged'
  snapshot: {
    seq: number
    epoch: number
    pageRows: number
    state: string
    summaries: unknown[]
    toolPreviews?: true
    displaySettings?: typeof CHAT_HISTORY_DISPLAY_VERSION
  }
  events: Array<{ seq: number; event: unknown; at?: number }>
  live: { afterSeq: number; liveSeq: number; events: unknown[] }
}

/**
 * Both clients open from the same projection. Older peers can request a full
 * replay. Other failures surface to the caller without an expensive second read.
 */
export async function openChatTimeline(
  io: { openTimeline(input: In<ChatHubSlice['chat']['openTimeline']>): Promise<unknown> },
  tabId: string,
  display?: ChatHistoryDisplay
): Promise<OpenedPaged | { kind: 'full' }> {
  try {
    const input = { tabId, version: TIMELINE_PROJECTION_VERSION }
    const compact = { ...input, toolPreviews: true }
    if (display) {
      const configured = (await io.openTimeline({ ...compact, display })) as
        | OpenedPaged
        | { kind: 'full' }
      if (configured.kind === 'paged') return configured
    }
    const projected = (await io.openTimeline(compact)) as OpenedPaged | { kind: 'full' }
    return projected.kind === 'paged'
      ? projected
      : ((await io.openTimeline(input)) as OpenedPaged | { kind: 'full' })
  } catch (error) {
    const code = (error as { data?: { code?: string } } | null)?.data?.code
    const message = error instanceof Error ? error.message : ''
    if (
      code === 'NOT_IMPLEMENTED' ||
      (code === 'NOT_FOUND' &&
        /no procedure found|no ["']?query["']?-procedure|procedure.*not found/i.test(message))
    )
      return { kind: 'full' }
    throw error
  }
}

/**
 * Pages sealed when the chat opened. The tail and later rows are already local.
 * Summaries stand in for pages the client hasn't loaded.
 */
export interface ChatPaging {
  pageRows: number
  sealed: number
  toolPreviews?: true
  displaySettings?: typeof CHAT_HISTORY_DISPLAY_VERSION
  summaries: TimelinePageSummary[]
}

export type OpenedChatHistory =
  | (WholeChatReplay & { kind: 'full' })
  | (WholeChatReplay & { kind: 'paged'; state: ChatTimelineState; paging: ChatPaging; seq: number })

/** Read and decode an initial history, using bounded event replay on older peers. */
export async function readInitialChatHistory(
  io: {
    openTimeline(input: In<ChatHubSlice['chat']['openTimeline']>): Promise<unknown>
    getReplay(input: In<ChatHubSlice['chat']['getReplay']>): Promise<unknown>
  },
  tabId: string,
  timer: ChatOpenTimer,
  stale: () => boolean,
  display?: ChatHistoryDisplay
): Promise<OpenedChatHistory | null> {
  const opened = await openChatTimeline(io, tabId, display)
  if (stale()) return null
  timer.mark('openMs')
  timer.set('paged', opened.kind === 'paged')
  if (opened.kind === 'full') {
    const replay = await readReplayPages(io, tabId, -1, stale)
    if (!replay || stale()) return null
    timer.mark('replayMs')
    timer.set('replayEvents', replay.events.length)
    return { kind: 'full', ...replay }
  }

  const { snapshot, events, live } = opened
  timer.set('stateChars', snapshot.state.length)
  timer.set('summaries', snapshot.summaries.length)
  timer.set('tailEvents', events.length)
  return {
    kind: 'paged',
    state: timer.time('restoreMs', () => decodeTimelineState(snapshot.state)),
    seq: snapshot.seq,
    paging: {
      pageRows: snapshot.pageRows,
      sealed: snapshot.summaries.length,
      toolPreviews: snapshot.toolPreviews,
      displaySettings: snapshot.displaySettings,
      summaries: snapshot.summaries as TimelinePageSummary[]
    },
    events: events as ChatHistoryPageEvent[],
    live
  }
}

type PagesAnswer =
  | { expired: true }
  | {
      expired: false
      pages: Array<{ page: number; from: number; rows: unknown[] }>
      omitted?: number[]
      /** The answer ended inside the first `omitted` page: ask again from this row. */
      next?: number
    }

/**
 * `timelinePages` for every page asked: an answer carries at most a byte budget of
 * rows and names the pages it left out (`omitted`), which are asked for again at
 * once. Asked from a row (`startRow`, always sent): a page larger than the budget
 * comes in row slices, the next asked from `next`. An older peer ignores
 * `startRow` and answers whole pages. `expired` as soon as one answer is.
 */
export async function timelinePagesAll(
  io: { timelinePages(input: In<ChatHubSlice['chat']['timelinePages']>): Promise<unknown> },
  input: {
    tabId: string
    pages: number[]
    asOfSeq: number
    epoch: number
    pageRows: number
    toolPreviews?: true
    display?: ChatHistoryDisplay
  },
  stale: () => boolean = () => false
): Promise<PagesAnswer | null> {
  const { pageRows, ...ask } = input
  const pages: Array<{ page: number; from: number; rows: unknown[] }> = []
  for (let wanted = ask.pages, startRow = (ask.pages[0] ?? 0) * pageRows; wanted.length > 0; ) {
    const res = (await io.timelinePages({ ...ask, pages: wanted, startRow })) as PagesAnswer
    if (stale()) return null
    if (res.expired) return res
    pages.push(...res.pages)
    const asked = wanted
    const again = (res.omitted ?? []).filter((page) => asked.includes(page))
    // An answer with no row and nothing left out has nothing more to give.
    if (res.pages.length === 0 || res.pages.every((p) => p.rows.length === 0)) break
    wanted = again
    startRow =
      res.next !== undefined && again[0] === Math.floor(res.next / pageRows)
        ? res.next
        : (again[0] ?? 0) * pageRows
  }
  return { expired: false, pages }
}

/** Pages asked for in one `timelinePages` request, at most. */
export const PAGES_PER_REQUEST = 32

/** Whether page `page` has a row not loaded. */
export function pageHasUnloaded(
  timeline: Readonly<TimelineRows>,
  page: number,
  pageRows: number
): boolean {
  const end = Math.min(timeline.length, (page + 1) * pageRows)
  for (let i = page * pageRows; i < end; i++) if (timeline[i] === undefined) return true
  return false
}

/** Ignore invalid, resident and in-flight pages before admitting a read. */
export function wantedTimelinePages(
  pages: readonly number[],
  timeline: Readonly<TimelineRows>,
  paging: Pick<ChatPaging, 'pageRows' | 'sealed'>,
  waiting: ReadonlySet<number>
): number[] {
  const { pageRows, sealed } = paging
  return [...new Set(pages)].filter(
    (page) =>
      page >= 0 && page < sealed && !waiting.has(page) && pageHasUnloaded(timeline, page, pageRows)
  )
}
