import {
  LegacyChatStorageRetiredError,
  legacyChatTables
} from '@slayzone/platform/legacy-chat-tables'
import type { SlayzoneDb } from '@slayzone/platform'
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
  insert(tabId: string, seq: number, event: AgentEvent, at: number): Promise<'inserted' | 'clash'>
  /** Local SQLite can commit before an event becomes visible. */
  insertSync?(tabId: string, seq: number, event: AgentEvent, at: number): 'inserted' | 'clash'
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

/** Let the event loop run (timers, sockets, heartbeats) between two pages of a long read. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * Turns for reading history pages, shared by every chat log of this process: one
 * page read (and what its caller does with it before awaiting again) per turn;
 * while other reads wait, the event loop runs between turns. A burst of hydrates
 * (a restore opening dozens of tabs) then parses about one page per loop turn in
 * total — never one page per tab per turn — so heartbeats and sockets stay
 * answered. (A lone long read yields between its own pages: `ChatEventLog.pages`.)
 */
export class HistoryReadTurns {
  private tail: Promise<void> = Promise.resolve()
  private waiting = 0

  take<T>(work: () => Promise<T>): Promise<T> {
    this.waiting++
    const run = this.tail.then(() => {
      this.waiting--
      return work()
    })
    const next = () => (this.waiting > 0 ? yieldToEventLoop() : undefined)
    this.tail = run.then(next, next)
    return run
  }
}

/** This process's {@link HistoryReadTurns}. */
export const historyReadTurns = new HistoryReadTurns()

/** Saved events of one {@link ChatEventLog.readPage}, oldest first; `hasMore`: read on after the last. */
export interface ChatLogPage {
  events: BufferedEvent[]
  hasMore: boolean
}

export interface ChatEventLogOptions {
  /** In-memory cache size (newest kept). Defaults to {@link CACHED_EVENTS_PER_TAB}. */
  cap?: number
  /** A row already existed at this seq — another writer. Logged, never overwritten. */
  onClash?: (seq: number, event: AgentEvent) => void
  /** The write itself failed (the event stays in memory; later writes continue). */
  onWriteError?: (seq: number, err: unknown) => void
}

/**
 * The saved history of ONE chat tab, and the sole owner of its sequence numbers.
 *
 * Every saved event gets the next seq HERE (never from a process), lands in the
 * in-memory ring at once (replay, broadcast) and is written through one serial
 * chain, so rows reach the DB in seq order and `flush()` means "everything
 * appended so far is on disk". A tab keeps one log across every process it runs,
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

  constructor(
    readonly tabId: string,
    private readonly persistence: ChatEventPersistence,
    seed: { events: BufferedEvent[]; nextSeq: number; evictedThrough?: number },
    private readonly opts: ChatEventLogOptions = {}
  ) {
    this.cap = opts.cap ?? CACHED_EVENTS_PER_TAB
    this.ring = seed.events.slice(-this.cap)
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

  /** Assign the next seq and the time it is saved, keep it in memory, and queue its write. */
  append(event: AgentEvent): BufferedEvent & { at: number } {
    const entry = { seq: this.nextSeq, event, at: Date.now() }
    if (this.persistence.insertSync) {
      try {
        if (this.persistence.insertSync(this.tabId, entry.seq, event, entry.at) === 'clash') {
          this.opts.onClash?.(entry.seq, event)
          throw new Error(`Chat event sequence ${entry.seq} already exists`)
        }
      } catch (err) {
        this.opts.onWriteError?.(entry.seq, err)
        throw err
      }
    }
    this.nextSeq++
    this.ring.push(entry)
    if (this.ring.length > this.cap) {
      const evicted = this.ring.splice(0, this.ring.length - this.cap)
      this.evictedThrough = evicted[evicted.length - 1].seq
    }
    if (!this.persistence.insertSync)
      this.chain = this.chain.then(async () => {
        try {
          const outcome = await this.persistence.insert(this.tabId, entry.seq, event, entry.at)
          if (outcome === 'clash') this.opts.onClash?.(entry.seq, event)
        } catch (err) {
          this.opts.onWriteError?.(entry.seq, err)
        }
      })
    return entry
  }

  /** Cached saved events after `afterSeq` — the newest `cap` at most. */
  since(afterSeq: number): BufferedEvent[] {
    return this.ring.filter((b) => b.seq > afterSeq)
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
    return historyReadTurns.take(() => this.readPageNow(afterSeq, budget, beforeSeq))
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
      // Evicted events were appended earlier: once flushed, they are on disk.
      await this.flush()
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

  /** Resolves once every event appended before this call is written (or failed). */
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
