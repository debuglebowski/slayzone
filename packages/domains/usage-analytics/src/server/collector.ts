/**
 * The computer side of `usage.collect` (robustness plan §9, P0): this computer keeps
 * its OWN read offsets into its agents' usage logs, and answers the hub only what is
 * new since them. The hub never holds a cursor.
 *
 * A cursor moves only after the hub stored the records it covers: every reply carries
 * a `receipt`, and the hub acknowledges it (`ack`) once that page is stored — with
 * the request for the next page, or alone after the last. A page the hub never
 * acknowledged (lost reply, hub restart, timeout) leaves its files' cursors where
 * they were, so the next collect parses those bytes again. Record ids are
 * deterministic (every parser hashes the record's own identity), and the hub inserts
 * with `INSERT OR IGNORE`, so a re-parse never counts twice.
 *
 * Paged: a reply never carries more than the byte budget of records. A whole backlog
 * (a first collect: 81 MiB measured) in one message neared the hub's 100 MiB
 * WebSocket limit — past it the socket closes and every terminal on the computer
 * detaches. The rest waits here under a token the hub asks for next.
 *
 * Lean like `collect.ts` (no DB): the cursor store is injected.
 *
 * @module usage-analytics/server/collector
 */
import { randomUUID } from 'node:crypto'
import type { ParseResult, UsageCursors } from './collect'

/** Records per reply, by their JSON size: far under the 100 MiB message limit. */
export const DEFAULT_PAGE_BYTES = 8 * 1024 * 1024
/** A collect the hub stopped asking for is dropped after this. */
const PAGES_TTL_MS = 10 * 60_000
/** Collects held at once (one per refresh; a few if refreshes overlap). */
const MAX_HELD = 4

/** Where a paged collect continues, or which page an `ack` confirms. */
export interface UsageCollectPage {
  token: string
  index: number
}

/** One file's slice of a page. `complete: false` = more of that file follows. */
export interface UsageCollectEntry {
  sourceFile: string
  fileMtimeMs: number
  endOffset: number
  complete?: boolean
  records: ParseResult['records']
}

export interface UsageCollectRequest {
  /** Continue a collect: the page to answer (no new parse). */
  page?: UsageCollectPage
  /** The hub stored this page: commit the cursors of the files it completes. */
  ack?: UsageCollectPage
  /**
   * One-time handoff of the hub's former cursors for this computer (hub v209). A
   * cursor this computer already keeps wins. Applied before the parse.
   */
  seed?: UsageCursors
}

export interface UsageCollectResponse {
  results: UsageCollectEntry[]
  /** More pages follow. */
  next?: UsageCollectPage
  /** Acknowledge this once the page is stored, or its cursors never move. */
  receipt?: UsageCollectPage
}

/** This computer's read offsets (its per-hub store). */
export interface UsageCursorStore {
  all(): UsageCursors
  /** Insert the cursors this store has none for; never overwrites one it keeps. */
  seed(cursors: UsageCursors): void
  /** Move these files' cursors (one transaction). */
  commit(entries: Array<{ sourceFile: string; offset: number; modifiedMs: number }>): void
}

/**
 * Split results into pages of at most `budget` bytes of records. A file larger than
 * a page spans several: every chunk but its last is `complete: false` and keeps the
 * file's old cursor, so its cursor only moves once all its records are delivered.
 */
export function pageUsage(
  results: ParseResult[],
  cursors: UsageCursors,
  budget: number
): UsageCollectEntry[][] {
  const pages: UsageCollectEntry[][] = []
  let page: UsageCollectEntry[] = []
  let bytes = 0
  const close = () => {
    if (page.length) pages.push(page)
    page = []
    bytes = 0
  }
  for (const result of results) {
    const header = result.sourceFile.length + 96
    let chunk: UsageCollectEntry['records'] = []
    const flushPartial = () => {
      page.push({
        sourceFile: result.sourceFile,
        fileMtimeMs: result.fileMtimeMs,
        endOffset: cursors[result.sourceFile]?.offset ?? 0,
        complete: false,
        records: chunk
      })
      chunk = []
      close()
    }
    if (bytes + header > budget) close()
    bytes += header
    for (const record of result.records) {
      const size = JSON.stringify(record).length + 1
      if (bytes + size > budget && (chunk.length > 0 || page.length > 0)) {
        if (chunk.length > 0) flushPartial()
        else close()
        bytes = header
      }
      chunk.push(record)
      bytes += size
    }
    page.push({
      sourceFile: result.sourceFile,
      fileMtimeMs: result.fileMtimeMs,
      endOffset: result.endOffset,
      records: chunk
    })
  }
  close()
  return pages.length ? pages : [[]]
}

export function createUsageCollector(opts: {
  /** This computer's cursor store; throws when it is unavailable (the collect fails). */
  store: () => UsageCursorStore
  /** Parse from these cursors (`collectUsage`, plus the caller's task tagging). */
  collect: (cursors: UsageCursors) => Promise<ParseResult[]>
  pageBytes?: number
  now?: () => number
}) {
  const budget = opts.pageBytes ?? DEFAULT_PAGE_BYTES
  const now = opts.now ?? Date.now
  const held = new Map<
    string,
    { pages: UsageCollectEntry[][]; acked: Set<number>; expiresAt: number }
  >()

  const reply = (token: string, index: number): UsageCollectResponse => {
    const h = held.get(token)
    if (!h) return { results: [] }
    const results = h.pages[index] ?? []
    const last = index + 1 >= h.pages.length
    return {
      results,
      receipt: { token, index },
      ...(last ? {} : { next: { token, index: index + 1 } })
    }
  }

  /** The hub stored page `index`: its complete files' cursors move, in page order. */
  const acknowledge = (ack: UsageCollectPage) => {
    const h = held.get(ack.token)
    if (!h || h.acked.has(ack.index)) return
    const page = h.pages[ack.index]
    if (!page) return
    opts.store().commit(
      page
        .filter((e) => e.complete !== false)
        .map((e) => ({
          sourceFile: e.sourceFile,
          offset: e.endOffset,
          modifiedMs: e.fileMtimeMs
        }))
    )
    h.acked.add(ack.index)
    if (h.acked.size >= h.pages.length) held.delete(ack.token)
  }

  async function handle(request: UsageCollectRequest): Promise<UsageCollectResponse> {
    const at = now()
    for (const [token, h] of held) if (h.expiresAt < at) held.delete(token)
    if (request.ack) acknowledge(request.ack)
    if (request.page) {
      const h = held.get(request.page.token)
      // Expired or unknown: nothing more here; the next collect parses again.
      if (!h) return { results: [] }
      h.expiresAt = at + PAGES_TTL_MS
      return reply(request.page.token, request.page.index)
    }
    // A bare acknowledgement (after the last page) parses nothing.
    if (request.ack) return { results: [] }
    const store = opts.store()
    if (request.seed && Object.keys(request.seed).length) store.seed(request.seed)
    const cursors = store.all()
    const pages = pageUsage(await opts.collect(cursors), cursors, budget)
    // Nothing new: no cursor to move, no receipt to acknowledge.
    if (pages.length === 1 && pages[0]!.length === 0) return { results: [] }
    while (held.size >= MAX_HELD) held.delete(held.keys().next().value as string)
    const token = randomUUID()
    held.set(token, { pages, acked: new Set(), expiresAt: at + PAGES_TTL_MS })
    return reply(token, 0)
  }

  return { handle }
}
