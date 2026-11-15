/**
 * Bounded reads of a chat's saved history. Every read that returns saved events
 * (or timeline rows) answers at most one PAGE: a byte budget plus a cursor, so no
 * single response, and no single synchronous step on the computer, carries a whole
 * conversation (chats reach hundreds of MB). Full history stays reachable by
 * reading page after page.
 *
 * Why 4 MiB: 25× under the computer socket's frame limit (100 MiB), with room for
 * the RPC envelope, the live snapshot and the hub's re-wrap; one page is one bounded
 * SQLite read plus parse/serialize of a few MB (tens of ms), so the computer keeps
 * answering heartbeats; a 200 MB chat is ~50 round trips. One event larger than the
 * budget is still returned, alone: a page never drops data.
 */
import type { AgentEvent } from './agent-events'

/** Serialized (UTF-8 JSON) bytes of saved events one page carries, at most (one event always fits). */
export const CHAT_HISTORY_PAGE_MAX_BYTES = 4 * 1024 * 1024
/** Saved events one page carries, at most. */
export const CHAT_HISTORY_PAGE_MAX_EVENTS = 2000

/** What a caller asks one page to hold; the computer clamps both to its maxima. */
export interface ChatHistoryPageBudget {
  maxBytes?: number
  maxEvents?: number
}

/** A budget with every field set, never above the maxima. */
export function clampChatHistoryPageBudget(
  budget: ChatHistoryPageBudget = {}
): Required<ChatHistoryPageBudget> {
  const clamp = (value: number | undefined, max: number) =>
    value !== undefined && Number.isFinite(value) && value >= 1
      ? Math.min(Math.floor(value), max)
      : max
  return {
    maxBytes: clamp(budget.maxBytes, CHAT_HISTORY_PAGE_MAX_BYTES),
    maxEvents: clamp(budget.maxEvents, CHAT_HISTORY_PAGE_MAX_EVENTS)
  }
}

/**
 * Where a page ends, from the stored sizes of the rows that may follow (oldest
 * first; a SQLite store reads them as `octet_length` from each record header, no
 * event body loaded). The first row always fits. `through`: the last seq of the
 * page (null: none); `more`: rows follow it. The store then loads only the rows
 * through `through` — never a row past its budget.
 */
export function cutChatHistoryPage(
  sizes: ReadonlyArray<{ seq: number; bytes: number }>,
  budget: Required<ChatHistoryPageBudget>
): { through: number | null; more: boolean } {
  let total = 0
  let through: number | null = null
  for (let i = 0; i < sizes.length; i++) {
    if (i > 0 && (i >= budget.maxEvents || total + sizes[i].bytes > budget.maxBytes))
      return { through, more: true }
    total += sizes[i].bytes
    through = sizes[i].seq
  }
  return { through, more: false }
}

/** One saved event as a page carries it (`BufferedEvent`'s wire shape). */
export interface ChatHistoryPageEvent {
  seq: number
  event: AgentEvent
  /** When it was saved (ms); absent only on old rows that never recorded it. */
  at?: number
}

/**
 * Saved events after a cursor, in seq order. `hasMore`: read the next page after
 * the last event's seq. A page with no events has no more.
 */
export interface ChatEventPage {
  events: ChatHistoryPageEvent[]
  hasMore: boolean
}

/** What streams right now (live-only blocks, never saved), as `getReplay` returns it. */
export interface ChatReplayLive {
  /** The saved seq these live events follow. */
  afterSeq: number
  /** The tab's live counter at this snapshot; later live events are newer. */
  liveSeq: number
  events: AgentEvent[]
}

/**
 * One page of a replay. The live snapshot comes with the LAST page only (`hasMore`
 * false), taken in the same tick its saved events end — exactly what a whole
 * replay answers in one piece.
 */
export type ChatReplayPage =
  | { events: ChatHistoryPageEvent[]; hasMore: true }
  | { events: ChatHistoryPageEvent[]; hasMore: false; live: ChatReplayLive }

/** Whether a replay answer is a page (`hasMore` set) or an older peer's whole replay. */
export function isChatReplayPage(value: unknown): value is ChatReplayPage {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { hasMore?: unknown }).hasMore === 'boolean'
  )
}

/** UTF-8 bytes of a value as JSON — what a page budget counts. */
export function jsonByteLength(value: unknown): number {
  const text = JSON.stringify(value) ?? ''
  return utf8Length(text)
}

/** UTF-8 length of a string without allocating a buffer (works in every runtime). */
export function utf8Length(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) bytes += 1
    else if (c < 0x800) bytes += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        i++
      } else bytes += 3
    } else bytes += 3
  }
  return bytes
}
