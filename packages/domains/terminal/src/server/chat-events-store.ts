import {
  LegacyChatStorageRetiredError,
  legacyChatTables
} from '@slayzone/platform/legacy-chat-tables'
import type { SlayzoneDb } from '@slayzone/platform'
import { historyReadTurns, yieldToEventLoop } from './history-turns'
import {
  clampChatHistoryPageBudget,
  cutChatHistoryPage,
  jsonByteLength,
  type AgentEvent,
  type ChatHistoryPageBudget
} from '@slayzone/terminal-contracts'

export interface BufferedEvent {
  seq: number
  event: AgentEvent
  /**
   * When it was saved (ms since epoch) — the time its rows show, the same on
   * every device and every replay. Rows saved before this existed read their
   * `created_at` (seconds) instead; absent only where neither is known.
   */
  at?: number
}

/**
 * Events a tab keeps IN MEMORY (`ChatEventLog`'s cache). Only a cache: the
 * table keeps every event of a tab, and `ChatEventLog.readSince` reads what
 * left the cache back from it — a conversation's history is never lost.
 */
export const CACHED_EVENTS_PER_TAB = 2000

/**
 * Insert one event row. INSERT-ONLY: a row already at `(tabId, seq)` is kept and
 * the write reports `'clash'` — the caller logs it as a bug. (It used to be
 * `INSERT OR REPLACE`, so a replaced process numbering from a stale seq silently
 * overwrote the new one's events.)
 */
export async function persistChatEvent(
  db: SlayzoneDb,
  tabId: string,
  seq: number,
  event: AgentEvent,
  at?: number
): Promise<'inserted' | 'clash'> {
  if (!(await legacyChatTables(db))) throw new LegacyChatStorageRetiredError('chat event')
  const res = await db
    .prepare(
      'INSERT INTO chat_events (tab_id, seq, event, saved_at) VALUES (?, ?, ?, ?) ON CONFLICT(tab_id, seq) DO NOTHING'
    )
    .run(tabId, seq, JSON.stringify(event), at ?? null)
  // No per-tab trimming: the whole history stays (it used to keep the newest
  // 2,000 rows and delete the rest). Old sessions age out by time instead
  // (hub session retention).
  return res.changes === 0 ? 'clash' : 'inserted'
}

/** A page budget with every field set (`clampChatHistoryPageBudget`). */
export type ChatPageBudget = Required<ChatHistoryPageBudget>

/**
 * Saved rows of one bounded read, oldest first. `bytes[i]`: the stored size of
 * `events[i]` (what a page budget counts). `more`: the range holds rows after the
 * last one returned.
 */
export interface StoredEventPage {
  events: BufferedEvent[]
  bytes: number[]
  more: boolean
}

/** Where a {@link ChatEventLog} writes its rows, and reads back what left its cache. */
export interface ChatEventPersistence {
  /**
   * The event as this store saves it (e.g. binary payloads moved out-of-line, see
   * `chat-blobs`). Called once per append, before the write: the log caches,
   * returns and writes what it returns, so memory, broadcasts and disk agree.
   */
  prepare?(tabId: string, event: AgentEvent): AgentEvent | Promise<AgentEvent>
  insert(tabId: string, seq: number, event: AgentEvent, at: number): Promise<'inserted' | 'clash'>
  /**
   * Saved events with `afterSeq < seq < beforeSeq`, oldest first, ONE page at most:
   * it stops before the event that would take it past `budget.maxBytes` (the first
   * one always fits) or at `budget.maxEvents`. Never reads (or parses) the rows
   * after the page.
   */
  readPage(
    tabId: string,
    afterSeq: number,
    beforeSeq: number,
    budget: ChatPageBudget
  ): Promise<StoredEventPage>
  /**
   * Seq of the `count`-th newest saved event — the oldest one a cache of `count`
   * keeps; null when there are fewer. An index read, no event is loaded.
   */
  tailStart(tabId: string, count: number): Promise<number | null>
}

/**
 * One page cut from rows already in memory (`rows` sorted by seq), with the same
 * rule as a store's {@link ChatEventPersistence.readPage}. For in-memory stores.
 */
export function pageOfRows(
  rows: readonly BufferedEvent[],
  afterSeq: number,
  beforeSeq: number,
  budget: ChatPageBudget,
  sizeOf: (entry: BufferedEvent) => number = (entry) => jsonByteLength(entry.event)
): StoredEventPage {
  const events: BufferedEvent[] = []
  const bytes: number[] = []
  let total = 0
  for (const entry of rows) {
    if (entry.seq <= afterSeq) continue
    if (entry.seq >= beforeSeq) break
    const size = sizeOf(entry)
    if (events.length > 0 && (events.length >= budget.maxEvents || total + size > budget.maxBytes))
      return { events, bytes, more: true }
    events.push(entry)
    bytes.push(size)
    total += size
  }
  return { events, bytes, more: false }
}

/** {@link ChatEventPersistence.tailStart} over rows already in memory (sorted by seq). */
export function tailStartOfRows(rows: readonly BufferedEvent[], count: number): number | null {
  return count >= 1 && rows.length >= count ? rows[rows.length - count].seq : null
}

// The process's turns for heavy history work: their own module (no transport, no
// child processes), so a store a hub bundles can take turns too.
export { HistoryReadTurns, historyReadTurns, yieldToEventLoop } from './history-turns'

/** Saved events of one {@link ChatEventLog.readPage}, oldest first; `hasMore`: read on after the last. */
export interface ChatLogPage {
  events: BufferedEvent[]
  hasMore: boolean
}

export interface ChatEventLogOptions {
  /** In-memory cache size (newest kept). Defaults to {@link CACHED_EVENTS_PER_TAB}. */
  cap?: number
  /** Start with a sequence lookup. Load saved events when a consumer reads them. */
  deferSeed?: boolean
  /** A row already existed at this seq — another writer. Logged, never overwritten. */
  onClash?: (seq: number, event: AgentEvent) => void
  /** The first failed write: the log stops accepting writes and every fence rejects. */
  onWriteError?: (seq: number, err: unknown) => void
}

/**
 * The saved history of ONE chat tab, and the sole owner of its sequence numbers.
 *
 * Every saved event gets the next seq HERE (never from a process). Its insert
 * commits before it enters the ring or resolves to a publisher. One serial chain
 * preserves append order; a failed insert poisons the prefix, so `flush()` cannot
 * acknowledge history absent from storage. A tab keeps one log across every process it runs,
 * which is what makes a respawn unable to re-use a seq.
 *
 * The ring is a cache of the newest `cap` events (`since`). Older history is read
 * back from the store ONE PAGE at a time (`readPage`, `pages`): no read parses a
 * whole conversation at once, and a long one yields to the event loop between
 * pages (chats reach hundreds of MB).
 */
export class ChatEventLog {
  private readonly ring: BufferedEvent[]
  private nextSeq: number
  private chain: Promise<void> = Promise.resolve()
  private readonly cap: number
  /** Highest seq no longer in the ring (-1: the ring holds the whole history). */
  private evictedThrough: number
  /** Serialized size of cached events (a page budget counts it), computed once. */
  private readonly sizes = new WeakMap<BufferedEvent, number>()
  private pendingRecent?: Promise<readonly BufferedEvent[]>
  private needsRecent: boolean

  constructor(
    readonly tabId: string,
    private readonly persistence: ChatEventPersistence,
    seed: { events: BufferedEvent[]; nextSeq: number; evictedThrough?: number },
    private readonly opts: ChatEventLogOptions = {}
  ) {
    this.cap = opts.cap ?? CACHED_EVENTS_PER_TAB
    this.ring = seed.events.slice(-this.cap)
    this.needsRecent = opts.deferSeed === true && (seed.evictedThrough ?? -1) >= 0
    const dropped = seed.events.length - this.ring.length
    this.evictedThrough = Math.max(
      dropped > 0 ? seed.events[dropped - 1].seq : -1,
      seed.evictedThrough ?? -1
    )
    const seededTail = this.ring.length > 0 ? this.ring[this.ring.length - 1].seq + 1 : 0
    this.nextSeq = Math.max(seed.nextSeq, seededTail)
  }

  /**
   * The log of a tab whose events are in the store: the ring is seeded with the
   * newest `cap` of them, read page by page (the history before them is never
   * loaded here). `nextSeq`: the store's durable sequence floor.
   */
  static async open(
    tabId: string,
    persistence: ChatEventPersistence,
    nextSeq: number,
    opts: ChatEventLogOptions = {}
  ): Promise<ChatEventLog> {
    if (opts.deferSeed) {
      const newest = (await persistence.tailStart(tabId, 1)) ?? -1
      return new ChatEventLog(
        tabId,
        persistence,
        { events: [], nextSeq: Math.max(nextSeq, newest + 1), evictedThrough: newest },
        opts
      )
    }
    const cap = opts.cap ?? CACHED_EVENTS_PER_TAB
    const start = await persistence.tailStart(tabId, cap)
    const evictedThrough = start === null ? -1 : start - 1
    const budget = clampChatHistoryPageBudget()
    const events: BufferedEvent[] = []
    const sizes: number[] = []
    for (let from = evictedThrough; ; ) {
      const after = from
      const page = await historyReadTurns.take(() =>
        persistence.readPage(tabId, after, Number.MAX_SAFE_INTEGER, budget)
      )
      events.push(...page.events)
      sizes.push(...page.bytes)
      if (!page.more || page.events.length === 0) break
      from = page.events[page.events.length - 1].seq
      await yieldToEventLoop()
    }
    const log = new ChatEventLog(tabId, persistence, { events, nextSeq, evictedThrough }, opts)
    events.forEach((entry, i) => log.sizes.set(entry, sizes[i]))
    return log
  }

  /** Seq of the newest saved event; -1 when there is none. */
  get lastSeq(): number {
    return this.nextSeq - 1
  }

  /** Seq of the newest event in the log (-1: none) — unlike `lastSeq`, never a bare sequence floor. */
  get newestSeq(): number {
    return this.ring.length > 0 ? this.ring[this.ring.length - 1].seq : this.evictedThrough
  }

  /** The cached (newest) saved events in seq order (bounded by the cap). */
  get events(): readonly BufferedEvent[] {
    return this.ring
  }

  /** Commit one event in append order before exposing its sequence or stored form. */
  append(raw: AgentEvent): Promise<BufferedEvent & { at: number }> {
    const at = Date.now()
    const written = this.chain.then(async () => {
      const seq = this.nextSeq
      let event = raw
      try {
        event = (await this.persistence.prepare?.(this.tabId, raw)) ?? raw
        if ((await this.persistence.insert(this.tabId, seq, event, at)) === 'clash') {
          this.opts.onClash?.(seq, event)
          throw new Error(`Chat event sequence ${seq} already exists`)
        }
      } catch (error) {
        // Notify only for the failed insert; queued successors inherit this error.
        this.opts.onWriteError?.(seq, error)
        throw error
      }
      const entry = { seq, event, at }
      this.nextSeq++
      this.ring.push(entry)
      if (this.ring.length > this.cap) {
        const evicted = this.ring.splice(0, this.ring.length - this.cap)
        this.evictedThrough = evicted[evicted.length - 1].seq
      }
      return entry
    })
    this.chain = written.then(() => undefined)
    // A publisher may be event-driven. Keep failures observed without converting
    // either the append result or a later flush into successful acknowledgements.
    void written.catch(() => undefined)
    void this.chain.catch(() => undefined)
    return written
  }

  /** Cached saved events after `afterSeq` — the newest `cap` at most. */
  since(afterSeq: number): BufferedEvent[] {
    return this.ring.filter((b) => b.seq > afterSeq)
  }

  /** The same bounded recent window on hot and cold tabs. */
  async readRecent(): Promise<readonly BufferedEvent[]> {
    if (!this.needsRecent || this.ring.length >= this.cap) return this.ring
    return (this.pendingRecent ??= this.loadRecent().finally(() => {
      this.pendingRecent = undefined
    }))
  }

  private async loadRecent(): Promise<readonly BufferedEvent[]> {
    const beforeSeq = this.evictedThrough + 1
    const start = await this.persistence.tailStart(this.tabId, this.cap)
    const saved: BufferedEvent[] = []
    for await (const page of this.pages(start === null ? -1 : start - 1, { beforeSeq }))
      saved.push(...page)
    if (this.ring.length < this.cap && saved.length > 0) {
      const restored = saved.slice(-(this.cap - this.ring.length))
      this.ring.unshift(...restored)
      this.evictedThrough = restored[0].seq - 1
    }
    this.needsRecent = false
    return this.ring
  }

  /**
   * ONE page of the saved events with `afterSeq < seq < beforeSeq`, oldest first:
   * at most `budget` (one event always fits). What left the cache is read back from
   * the store (only that page of it); the rest comes from the cache. `hasMore`: read
   * on after the last event (events appended meanwhile included, never doubled).
   */
  readPage(
    afterSeq: number,
    budget: ChatHistoryPageBudget = {},
    beforeSeq: number = Number.MAX_SAFE_INTEGER
  ): Promise<ChatLogPage> {
    // One page per turn across every log of the process (`historyReadTurns`).
    const prefix = this.chain
    // Await writes before acquiring a history turn (projection work may need one).
    return prefix.then(() =>
      historyReadTurns.take(() => this.readPageNow(afterSeq, budget, beforeSeq))
    )
  }

  private async readPageNow(
    afterSeq: number,
    budget: ChatHistoryPageBudget,
    beforeSeq: number
  ): Promise<ChatLogPage> {
    const limits = clampChatHistoryPageBudget(budget)
    let from = afterSeq
    while (from < this.evictedThrough && from < beforeSeq - 1) {
      const through = this.evictedThrough
      // Evicted rows committed before entering the cache. Never await a later
      // writer prefix while holding this history turn: its work may need one.
      const page = await this.persistence.readPage(
        this.tabId,
        from,
        Math.min(through + 1, beforeSeq),
        limits
      )
      if (page.events.length > 0) {
        const last = page.events[page.events.length - 1].seq
        return {
          events: page.events,
          hasMore: page.more || Math.min(this.lastSeq, beforeSeq - 1) > last
        }
      }
      // Nothing stored up to `through` (retention removed it): go on after it.
      from = through
    }
    const page = pageOfRows(this.ring, from, beforeSeq, limits, (entry) => this.sizeOf(entry))
    return { events: page.events, hasMore: page.more }
  }

  /**
   * Every saved event after `afterSeq` (and before `beforeSeq`), one page at a
   * time: each read in its turn (`historyReadTurns`, shared with every other read
   * of the process), the loop running between pages — the caller handles a page
   * in the turn it got it.
   */
  async *pages(
    afterSeq = -1,
    opts: { budget?: ChatHistoryPageBudget; beforeSeq?: number } = {}
  ): AsyncGenerator<BufferedEvent[]> {
    let from = afterSeq
    for (let first = true; ; first = false) {
      if (!first) await yieldToEventLoop()
      const page = await this.readPage(from, opts.budget, opts.beforeSeq)
      if (page.events.length > 0) {
        yield page.events
        from = page.events[page.events.length - 1].seq
      }
      if (!page.hasMore || page.events.length === 0) return
    }
  }

  /**
   * EVERY saved event after `afterSeq`, in seq order, read page by page (the
   * event loop runs between pages). Events appended meanwhile are included, never
   * doubled. Holds the whole result in memory: for callers that need it all.
   */
  async readSince(afterSeq: number): Promise<BufferedEvent[]> {
    const out: BufferedEvent[] = []
    for await (const page of this.pages(afterSeq)) out.push(...page)
    return out
  }

  /** Resolves after the captured append prefix commits; rejects on any failed write. */
  flush(): Promise<void> {
    return this.chain
  }

  private sizeOf(entry: BufferedEvent): number {
    let size = this.sizes.get(entry)
    if (size === undefined) {
      size = jsonByteLength(entry.event)
      this.sizes.set(entry, size)
    }
    return size
  }
}

interface EventRow {
  seq: number
  event: string
  saved_at: number | null
  created_at: string | null
}

const EVENT_COLUMNS = 'seq, event, saved_at, created_at'

/** SQLite's `datetime('now')` (`YYYY-MM-DD HH:MM:SS`, UTC) in ms; undefined when unreadable. */
function createdAtMs(createdAt: string | null): number | undefined {
  if (!createdAt) return undefined
  const ms = Date.parse(`${createdAt.replace(' ', 'T')}Z`)
  return Number.isNaN(ms) ? undefined : ms
}

/** Parsed rows; a corrupt one is dropped (better than crashing the chat panel). */
function toBuffered(rows: EventRow[]): BufferedEvent[] {
  const out: BufferedEvent[] = []
  for (const row of rows) {
    let event: AgentEvent
    try {
      event = JSON.parse(row.event) as AgentEvent
    } catch {
      continue
    }
    const at = row.saved_at ?? createdAtMs(row.created_at)
    out.push(at === undefined ? { seq: row.seq, event } : { seq: row.seq, event, at })
  }
  return out
}

export async function loadChatEvents(db: SlayzoneDb, tabId: string): Promise<BufferedEvent[]> {
  if (!(await legacyChatTables(db))) return []
  const rows = (await db
    .prepare(`SELECT ${EVENT_COLUMNS} FROM chat_events WHERE tab_id = ? ORDER BY seq ASC`)
    .all(tabId)) as EventRow[]
  return toBuffered(rows)
}

export async function loadChatEventsRange(
  db: SlayzoneDb,
  tabId: string,
  afterSeq: number,
  beforeSeq: number
): Promise<BufferedEvent[]> {
  if (!(await legacyChatTables(db))) return []
  const rows = (await db
    .prepare(
      `SELECT ${EVENT_COLUMNS} FROM chat_events WHERE tab_id = ? AND seq > ? AND seq < ? ORDER BY seq ASC`
    )
    .all(tabId, afterSeq, beforeSeq)) as EventRow[]
  return toBuffered(rows)
}

/** {@link ChatEventPersistence.readPage} over the legacy `chat_events` table. */
export async function loadChatEventsPage(
  db: SlayzoneDb,
  tabId: string,
  afterSeq: number,
  beforeSeq: number,
  budget: ChatPageBudget
): Promise<StoredEventPage> {
  if (!(await legacyChatTables(db))) return { events: [], bytes: [], more: false }
  // One row past the page limit tells whether more follow.
  const sizes = (await db
    .prepare(
      'SELECT seq, octet_length(event) AS bytes FROM chat_events WHERE tab_id = ? AND seq > ? AND seq < ? ORDER BY seq ASC LIMIT ?'
    )
    .all(tabId, afterSeq, beforeSeq, budget.maxEvents + 1)) as Array<{ seq: number; bytes: number }>
  const cut = cutChatHistoryPage(sizes, budget)
  if (cut.through === null) return { events: [], bytes: [], more: false }
  const rows = (await db
    .prepare(
      `SELECT ${EVENT_COLUMNS} FROM chat_events WHERE tab_id = ? AND seq > ? AND seq <= ? ORDER BY seq ASC`
    )
    .all(tabId, afterSeq, cut.through)) as EventRow[]
  const bySeq = new Map(sizes.map((r) => [r.seq, r.bytes]))
  const events = toBuffered(rows)
  return { events, bytes: events.map((e) => bySeq.get(e.seq) ?? 0), more: cut.more }
}

/** {@link ChatEventPersistence.tailStart} over the legacy `chat_events` table. */
export async function chatEventsTailStart(
  db: SlayzoneDb,
  tabId: string,
  count: number
): Promise<number | null> {
  if (count < 1 || !(await legacyChatTables(db))) return null
  const row = (await db
    .prepare('SELECT seq FROM chat_events WHERE tab_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?')
    .get(tabId, count - 1)) as { seq: number } | undefined
  return row?.seq ?? null
}

export async function getNextSeqForTab(db: SlayzoneDb, tabId: string): Promise<number> {
  if (!(await legacyChatTables(db))) return 0
  const row = (await db
    .prepare('SELECT MAX(seq) AS max_seq FROM chat_events WHERE tab_id = ?')
    .get(tabId)) as { max_seq: number | null } | undefined
  if (!row || row.max_seq === null) return 0
  return row.max_seq + 1
}

export async function clearChatEventsForTab(db: SlayzoneDb, tabId: string): Promise<void> {
  if (!(await legacyChatTables(db))) return
  await db.prepare('DELETE FROM chat_events WHERE tab_id = ?').run(tabId)
}
