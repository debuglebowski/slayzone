import type { SlayzoneDb } from '@slayzone/platform'
import type { AgentEvent } from '@slayzone/terminal-contracts'

export interface BufferedEvent {
  seq: number
  event: AgentEvent
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
  event: AgentEvent
): Promise<'inserted' | 'clash'> {
  const res = await db
    .prepare(
      'INSERT INTO chat_events (tab_id, seq, event) VALUES (?, ?, ?) ON CONFLICT(tab_id, seq) DO NOTHING'
    )
    .run(tabId, seq, JSON.stringify(event))
  // No per-tab trimming: the whole history stays (it used to keep the newest
  // 2,000 rows and delete the rest). Old sessions age out by time instead
  // (hub session retention).
  return res.changes === 0 ? 'clash' : 'inserted'
}

/** Where a {@link ChatEventLog} writes its rows, and reads back what left its cache. */
export interface ChatEventPersistence {
  insert(tabId: string, seq: number, event: AgentEvent): Promise<'inserted' | 'clash'>
  /** Saved events with `afterSeq < seq < beforeSeq`, in seq order. */
  readRange(tabId: string, afterSeq: number, beforeSeq: number): Promise<BufferedEvent[]>
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
 * The ring is a cache of the newest `cap` events (`since`). The whole history
 * is `readSince`: what left the ring is read back from the store.
 */
export class ChatEventLog {
  private readonly ring: BufferedEvent[]
  private nextSeq: number
  private chain: Promise<void> = Promise.resolve()
  private readonly cap: number
  /** Highest seq no longer in the ring (-1: the ring holds the whole history). */
  private evictedThrough: number

  constructor(
    readonly tabId: string,
    private readonly persistence: ChatEventPersistence,
    seed: { events: BufferedEvent[]; nextSeq: number },
    private readonly opts: ChatEventLogOptions = {}
  ) {
    this.cap = opts.cap ?? CACHED_EVENTS_PER_TAB
    this.ring = seed.events.slice(-this.cap)
    const dropped = seed.events.length - this.ring.length
    this.evictedThrough = dropped > 0 ? seed.events[dropped - 1].seq : -1
    const seededTail = this.ring.length > 0 ? this.ring[this.ring.length - 1].seq + 1 : 0
    this.nextSeq = Math.max(seed.nextSeq, seededTail)
  }

  /** Seq of the newest saved event; -1 when there is none. */
  get lastSeq(): number {
    return this.nextSeq - 1
  }

  /** The cached (newest) saved events in seq order (bounded by the cap). */
  get events(): readonly BufferedEvent[] {
    return this.ring
  }

  /** Assign the next seq, keep it in memory, and queue its write. */
  append(event: AgentEvent): BufferedEvent {
    const entry: BufferedEvent = { seq: this.nextSeq++, event }
    this.ring.push(entry)
    if (this.ring.length > this.cap) {
      const evicted = this.ring.splice(0, this.ring.length - this.cap)
      this.evictedThrough = evicted[evicted.length - 1].seq
    }
    this.chain = this.chain.then(async () => {
      try {
        const outcome = await this.persistence.insert(this.tabId, entry.seq, event)
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
   * EVERY saved event after `afterSeq`, in seq order: the part that left the
   * cache is read back from the store, the rest comes from the cache. Events
   * appended meanwhile are included, never doubled: when the cache moves on
   * during a read, the next stretch is read too.
   */
  async readSince(afterSeq: number): Promise<BufferedEvent[]> {
    const out: BufferedEvent[] = []
    let from = afterSeq
    while (from < this.evictedThrough) {
      const through = this.evictedThrough
      // Evicted events were appended earlier: once flushed, they are on disk.
      await this.flush()
      out.push(...(await this.persistence.readRange(this.tabId, from, through + 1)))
      from = through
    }
    out.push(...this.since(from))
    return out
  }

  /** Resolves once every event appended before this call is written (or failed). */
  flush(): Promise<void> {
    return this.chain
  }
}

export async function loadChatEvents(db: SlayzoneDb, tabId: string): Promise<BufferedEvent[]> {
  const rows = (await db
    .prepare('SELECT seq, event FROM chat_events WHERE tab_id = ? ORDER BY seq ASC')
    .all(tabId)) as Array<{ seq: number; event: string }>
  const out: BufferedEvent[] = []
  for (const row of rows) {
    try {
      out.push({ seq: row.seq, event: JSON.parse(row.event) as AgentEvent })
    } catch {
      // Drop corrupt rows silently — better than crashing the chat panel.
    }
  }
  return out
}

export async function loadChatEventsRange(
  db: SlayzoneDb,
  tabId: string,
  afterSeq: number,
  beforeSeq: number
): Promise<BufferedEvent[]> {
  const rows = (await db
    .prepare(
      'SELECT seq, event FROM chat_events WHERE tab_id = ? AND seq > ? AND seq < ? ORDER BY seq ASC'
    )
    .all(tabId, afterSeq, beforeSeq)) as Array<{ seq: number; event: string }>
  const out: BufferedEvent[] = []
  for (const row of rows) {
    try {
      out.push({ seq: row.seq, event: JSON.parse(row.event) as AgentEvent })
    } catch {
      // Drop corrupt rows silently — as loadChatEvents does.
    }
  }
  return out
}

export async function getNextSeqForTab(db: SlayzoneDb, tabId: string): Promise<number> {
  const row = (await db
    .prepare('SELECT MAX(seq) AS max_seq FROM chat_events WHERE tab_id = ?')
    .get(tabId)) as { max_seq: number | null } | undefined
  if (!row || row.max_seq === null) return 0
  return row.max_seq + 1
}

export async function clearChatEventsForTab(db: SlayzoneDb, tabId: string): Promise<void> {
  await db.prepare('DELETE FROM chat_events WHERE tab_id = ?').run(tabId)
}
