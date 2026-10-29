import type { SlayzoneDb } from '@slayzone/platform'
import type { AgentEvent } from '@slayzone/terminal-contracts'

export interface BufferedEvent {
  seq: number
  event: AgentEvent
}

/** Match in-memory MAX_BUFFER_EVENTS in chat-transport-manager. */
export const MAX_PERSISTED_EVENTS_PER_TAB = 2000

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
  if (res.changes === 0) return 'clash'

  // Retention: keep newest MAX rows per tab. Cheap because seq is monotonic.
  await db
    .prepare(
      `DELETE FROM chat_events
     WHERE tab_id = ?
       AND seq <= (
         SELECT seq FROM chat_events
         WHERE tab_id = ?
         ORDER BY seq DESC
         LIMIT 1 OFFSET ?
       )`
    )
    .run(tabId, tabId, MAX_PERSISTED_EVENTS_PER_TAB)
  return 'inserted'
}

/** Where a {@link ChatEventLog} writes its rows. */
export interface ChatEventPersistence {
  insert(tabId: string, seq: number, event: AgentEvent): Promise<'inserted' | 'clash'>
}

export interface ChatEventLogOptions {
  /** In-memory cap (newest kept). Defaults to {@link MAX_PERSISTED_EVENTS_PER_TAB}. */
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
 */
export class ChatEventLog {
  private readonly ring: BufferedEvent[]
  private nextSeq: number
  private chain: Promise<void> = Promise.resolve()
  private readonly cap: number

  constructor(
    readonly tabId: string,
    private readonly persistence: ChatEventPersistence,
    seed: { events: BufferedEvent[]; nextSeq: number },
    private readonly opts: ChatEventLogOptions = {}
  ) {
    this.cap = opts.cap ?? MAX_PERSISTED_EVENTS_PER_TAB
    this.ring = seed.events.slice(-this.cap)
    const seededTail = this.ring.length > 0 ? this.ring[this.ring.length - 1].seq + 1 : 0
    this.nextSeq = Math.max(seed.nextSeq, seededTail)
  }

  /** Seq of the newest saved event; -1 when there is none. */
  get lastSeq(): number {
    return this.nextSeq - 1
  }

  /** Saved events in seq order (bounded by the cap). */
  get events(): readonly BufferedEvent[] {
    return this.ring
  }

  /** Assign the next seq, keep it in memory, and queue its write. */
  append(event: AgentEvent): BufferedEvent {
    const entry: BufferedEvent = { seq: this.nextSeq++, event }
    this.ring.push(entry)
    if (this.ring.length > this.cap) this.ring.splice(0, this.ring.length - this.cap)
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

  since(afterSeq: number): BufferedEvent[] {
    return this.ring.filter((b) => b.seq > afterSeq)
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
