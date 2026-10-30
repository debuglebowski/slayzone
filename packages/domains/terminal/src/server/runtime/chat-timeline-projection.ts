/**
 * The hub's timeline projection of ONE chat tab: the chat reducer run over the
 * tab's saved events, as they are saved — so a client opens a paged session
 * from it (the reducer state as of now, its newest rows, and a summary per page
 * of the older ones) instead of replaying the whole history.
 *
 * Rows are kept in pages of {@link TIMELINE_PAGE_ROWS}: a page is SEALED once
 * at least a page of rows sits after it (the tail — the newest rows — stays in
 * memory, so a popped message or a streaming row is never in a page). Sealed
 * pages are written to `chat_timeline_pages`; only the most recently used stay
 * in memory, and the reducer loads one when it needs a row of it (a late tool
 * result for an old call). A page a later event changes is written again.
 *
 * Persisted state is DERIVED and versioned (`CHAT_TIMELINE_VERSION`): a
 * checkpoint of another version, one ahead of the events, or one that can't be
 * read is thrown away and the projection is rebuilt from the events. A store
 * failure stops persisting for the tab (the next open rebuilds); it never
 * stops the chat.
 */
import type { AgentEvent } from '@slayzone/terminal-contracts'
import {
  initialState,
  reducer,
  type ChatTimelineState,
  type TimelineItem,
  type TimelineRows
} from '../../shared/chat-timeline'
import {
  TIMELINE_PROJECTION_VERSION,
  decodeTimelineState,
  encodeTimelineState
} from '../../shared/chat-timeline-checkpoint'

export { TIMELINE_PROJECTION_VERSION }
import {
  pageSearchText,
  searchableText,
  summarizeRows,
  type TimelinePageSummary
} from '../../shared/timeline-summary'
import type { BufferedEvent } from '../chat-events-store'
import type { TimelineCheckpointRow, TimelineWrite } from '../chat-timeline-store'

export const TIMELINE_PAGE_ROWS = 256
/** Sealed pages kept in memory besides the tail, most recently used. */
const RESIDENT_PAGES = 8
/** Row changes remembered, so rows can be served as they were at an earlier seq. */
const UNDO_KEEP = 4096
const FLUSH_DELAY_MS = 1500
/** Events folded per step of a long run (a rebuild): pages written + unloaded between steps. */
const FOLD_CHUNK = 256
/** Where the projection persists (the tab's rows of `chat-timeline-store.ts`). */
export interface TimelineProjectionStore {
  loadCheckpoint(): Promise<TimelineCheckpointRow | null>
  loadPages(pages: readonly number[]): Promise<Array<{ page: number; rows: string }>>
  loadSummaries(): Promise<Array<{ page: number; summary: string }>>
  save(write: TimelineWrite): Promise<void>
  searchPages(needleLower: string): Promise<number[]>
  /** Throw the stored projection away (the next open rebuilds it from the events). */
  discard(): Promise<void>
}

/** What a client opens a paged session from. */
export interface TimelineOpen {
  version: string
  /** The newest saved event folded in: the client goes on with the events after it. */
  seq: number
  /** `rowsEpoch` of the state: page requests name it. */
  epoch: number
  pageRows: number
  /** The reducer state (`encodeTimelineState`): rows before `sealed * pageRows` unloaded. */
  state: string
  /** One per sealed page, in page order. */
  summaries: TimelinePageSummary[]
}

/** Rows of pages as of an earlier seq, or `expired` (rows moved / too old: open again). */
export type TimelinePagesResult =
  | { expired: false; pages: Array<{ page: number; from: number; rows: TimelineItem[] }> }
  | { expired: true }

interface CheckpointData {
  sealed: number
  state: string
}

export class TimelineProjection {
  private state: ChatTimelineState
  private seq = -1
  /** Pages `0..sealed-1` are sealed (rows before `sealed * PAGE` are paged). */
  private sealed = 0
  private summaries: TimelinePageSummary[] = []
  private readonly dirty = new Set<number>()
  /** Delete every page from this one on at the next flush (rows moved). */
  private dropFrom: number | null = null
  /** Sealed pages whose rows are in memory, least recently used first. */
  private resident: number[] = []
  /** Row changes, oldest first: `prev` is the row before event `seq` changed it. */
  private undo: Array<{ seq: number; row: number; prev: TimelineItem }> = []
  /** Rows can be served as of any seq from this one on (older: expired). */
  private undoFloor = -1
  private chain: Promise<unknown> = Promise.resolve()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private checkpointDirty = false
  /** A store failure: stop persisting and keep every row in memory (the next open rebuilds). */
  private broken = false
  /** A step failed: this projection may be wrong — clients open from the events instead. */
  private failed = false
  private closed = false
  private peakResident = 0
  /** The stored checkpoint was deleted by a write ahead of it (none stored yet since). */
  private checkpointDropped = false

  private constructor(
    private readonly store: TimelineProjectionStore,
    private readonly agentStartedTurns: boolean,
    private readonly onError: (what: string, err: unknown) => void
  ) {
    this.state = initialState({ agentStartedTurns })
  }

  /**
   * The projection of a tab whose saved events are `history` (all of them, in
   * seq order): from its checkpoint when one fits, else rebuilt.
   */
  static async open(opts: {
    store: TimelineProjectionStore
    history: readonly BufferedEvent[]
    agentStartedTurns: boolean
    onError?: (what: string, err: unknown) => void
  }): Promise<TimelineProjection> {
    const p = new TimelineProjection(
      opts.store,
      opts.agentStartedTurns,
      opts.onError ?? ((what, err) => console.error(`[chat-timeline] ${what}:`, err))
    )
    await p.init(opts.history)
    return p
  }

  private async init(history: readonly BufferedEvent[]): Promise<void> {
    const lastSeq = history.length > 0 ? history[history.length - 1].seq : -1
    if (await this.restore(lastSeq)) {
      const after = history.filter((b) => b.seq > this.seq)
      await this.applyRun(after)
      // Pages went out along the way (the checkpoint with them): store one again.
      if (this.checkpointDropped) await this.flush()
      return
    }
    // Rebuild: every event, every page written again.
    this.state = initialState({ agentStartedTurns: this.agentStartedTurns })
    this.seq = -1
    this.sealed = 0
    this.summaries = []
    this.dropFrom = 0
    if (history.length === 0) this.checkpointDirty = true
    await this.applyRun(history)
    await this.flush()
  }

  /**
   * Fold a long run of events in (open: a rebuild, or the events after the
   * checkpoint) a chunk at a time, writing pages out as it goes: memory holds
   * the tail and the budget of pages, never the whole history. Those writes
   * carry no checkpoint (it covers the whole history's indexes: one per run,
   * by the caller).
   */
  private async applyRun(entries: readonly BufferedEvent[]): Promise<void> {
    for (let i = 0; i < entries.length; i += FOLD_CHUNK) {
      await this.applyBatch(entries.slice(i, i + FOLD_CHUNK))
      await this.flushIfOverBudget(false)
    }
  }

  /** Over the page budget (changes to many old pages): write them out now, then unload. */
  private async flushIfOverBudget(withCheckpoint = true): Promise<void> {
    if (this.resident.length > RESIDENT_PAGES) await this.flushNow(withCheckpoint)
  }

  /** From the stored checkpoint, when it fits these events. */
  private async restore(lastSeq: number): Promise<boolean> {
    try {
      const cp = await this.store.loadCheckpoint()
      if (!cp || cp.version !== TIMELINE_PROJECTION_VERSION || cp.seq > lastSeq) return false
      const data = JSON.parse(cp.data) as CheckpointData
      const state = decodeTimelineState(data.state)
      if (state.agentStartedTurns !== this.agentStartedTurns) return false
      const summaries = await this.store.loadSummaries()
      if (summaries.length !== data.sealed || summaries.some((s, i) => s.page !== i)) return false
      this.state = state
      this.seq = cp.seq
      this.sealed = data.sealed
      this.summaries = summaries.map((s) => JSON.parse(s.summary) as TimelinePageSummary)
      this.undoFloor = cp.seq
      return true
    } catch (err) {
      this.onError('checkpoint unreadable, rebuilding', err)
      return false
    }
  }

  /** The newest saved event folded in. */
  get lastSeq(): number {
    return this.seq
  }

  /** Most sealed pages ever held in memory at once — diagnostics, tests. */
  get peakResidentPages(): number {
    return this.peakResident
  }

  /** Rows held in memory (the tail and the resident pages) — diagnostics, tests. */
  get residentRows(): number {
    let n = 0
    for (const row of this.state.timeline) if (row !== undefined) n++
    return n
  }

  /** False once a step failed: open from the events instead (`openSnapshot` refuses). */
  get usable(): boolean {
    return !this.failed
  }

  /** A saved event, in seq order (later ones queue behind it). */
  apply(entry: BufferedEvent): void {
    void this.enqueue(async () => {
      if (this.failed || entry.seq <= this.seq) return
      try {
        await this.applyBatch([entry])
        await this.flushIfOverBudget()
      } catch (err) {
        this.fail(err)
      }
    }).catch(() => undefined)
  }

  /** What a client opens from, once every event queued so far is folded in. */
  openSnapshot(): Promise<TimelineOpen> {
    return this.enqueue(async () => {
      if (this.failed) throw new Error('the timeline projection failed')
      return {
        version: TIMELINE_PROJECTION_VERSION,
        seq: this.seq,
        epoch: this.state.rowsEpoch,
        pageRows: TIMELINE_PAGE_ROWS,
        state: encodeTimelineState(this.state, this.sealed * TIMELINE_PAGE_ROWS),
        summaries: this.summaries
      }
    })
  }

  /**
   * The rows of `pages` as they were after event `asOfSeq` (a client's newest,
   * maybe behind the hub). Expired when rows moved since (`epoch`) or the
   * changes since are no longer remembered.
   */
  pagesAsOf(
    pages: readonly number[],
    asOfSeq: number,
    epoch: number
  ): Promise<TimelinePagesResult> {
    return this.enqueue(async (): Promise<TimelinePagesResult> => {
      if (
        this.failed ||
        epoch !== this.state.rowsEpoch ||
        asOfSeq < this.undoFloor ||
        asOfSeq > this.seq
      ) {
        return { expired: true }
      }
      const wanted = pages.filter((p) => p >= 0 && p < this.sealed)
      const out: Array<{ page: number; from: number; rows: TimelineItem[] }> = []
      try {
        for (const page of wanted) {
          // In memory, or as stored (a page leaves memory only once stored: current).
          const rows = this.resident.includes(page)
            ? this.pageRows(page)
            : await this.readPage(page)
          out.push({ page, from: page * TIMELINE_PAGE_ROWS, rows })
        }
      } catch (err) {
        // The client opens again (from the events: this one is no longer served).
        this.fail(err)
        return { expired: true }
      }
      // Undo what happened after `asOfSeq`, newest first.
      for (let k = this.undo.length - 1; k >= 0 && this.undo[k].seq > asOfSeq; k--) {
        const u = this.undo[k]
        const hit = out.find((p) => u.row >= p.from && u.row < p.from + p.rows.length)
        if (hit) hit.rows[u.row - hit.from] = u.prev
      }
      return { expired: false, pages: out }
    })
  }

  /**
   * Sealed pages that may hold `query` (a superset: the caller checks the rows
   * it loads). Pages changed since they were written are always in.
   */
  searchPages(query: string): Promise<number[]> {
    return this.enqueue(async () => {
      const needle = query.toLowerCase()
      if (!needle) return []
      let stored: number[] = []
      try {
        stored = await this.store.searchPages(needle)
      } catch (err) {
        this.onError('search failed', err)
        // Without the index: every page may hold it.
        stored = Array.from({ length: this.sealed }, (_, i) => i)
      }
      const pages = new Set(stored.filter((p) => p < this.sealed))
      for (const p of this.dirty) if (p < this.sealed) pages.add(p)
      // A page in memory is checked here (cheap, and its stored text may be stale).
      for (const p of this.resident) {
        const from = p * TIMELINE_PAGE_ROWS
        const rows = this.state.timeline.slice(from, from + TIMELINE_PAGE_ROWS)
        if (rows.some((r) => r && searchableText(r).toLowerCase().includes(needle))) pages.add(p)
        else if (!this.dirty.has(p)) pages.delete(p)
      }
      return [...pages].sort((a, b) => a - b)
    })
  }

  /** Write what changed (dirty pages + checkpoint) now. */
  flush(): Promise<void> {
    return this.enqueue(() => this.flushNow())
  }

  /** Flush and stop (the tab closed). */
  async close(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    await this.flush()
    this.closed = true
  }

  // ---- internals ----

  /**
   * A step failed (a stored page unreadable, ...): its state may no longer
   * follow the events. Never served or written again, and what is stored is
   * thrown away so the next open rebuilds (it is derived; nothing is lost).
   */
  private fail(err: unknown): void {
    if (this.failed) return
    this.failed = true
    this.broken = true
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    this.onError('projection failed, thrown away', err)
    void this.store
      .discard()
      .catch((e: unknown) => this.onError('throwing the stored projection away failed', e))
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work)
    this.chain = run.catch((err: unknown) => this.onError('projection step failed', err))
    return run
  }

  /** Fold saved events in (loading pages the reducer asks for), then seal / track changes. */
  private async applyBatch(entries: readonly BufferedEvent[]): Promise<void> {
    const before = this.state
    const loaded = new Map<number, TimelineItem>()
    let next = reducer(before, {
      type: 'events',
      events: entries.map((b) => b.event as AgentEvent),
      at: entries.map((b) => b.at),
      seq: entries.map((b) => b.seq)
    })
    while (next.stalled) {
      const page = Math.floor(next.stalled.need / TIMELINE_PAGE_ROWS)
      const rows = await this.readPage(page)
      rows.forEach((r, k) => loaded.set(page * TIMELINE_PAGE_ROWS + k, r))
      this.touch(page)
      next = reducer(next, {
        type: 'rows-loaded',
        from: page * TIMELINE_PAGE_ROWS,
        rows,
        epoch: next.rowsEpoch
      })
    }
    const seq = entries[entries.length - 1].seq
    this.state = next
    this.seq = seq
    this.checkpointDirty = true
    if (next.rowsEpoch !== before.rowsEpoch) this.rowsMoved()
    else this.trackChanges(before.timeline, next.timeline, loaded, seq)
    this.seal()
    this.scheduleFlush()
  }

  /** Rows changed in place (not added): remember them; their sealed pages go out again. */
  private trackChanges(
    before: TimelineRows,
    after: TimelineRows,
    loaded: ReadonlyMap<number, TimelineItem>,
    seq: number
  ): void {
    if (before === after) return
    const n = Math.min(before.length, after.length)
    for (let i = 0; i < n; i++) {
      const prev = before[i] ?? loaded.get(i)
      const now = after[i]
      if (prev === undefined || now === undefined || prev === now) continue
      this.undo.push({ seq, row: i, prev })
      const page = Math.floor(i / TIMELINE_PAGE_ROWS)
      if (page < this.sealed) {
        this.dirty.add(page)
        this.summaries[page] = this.summaryOf(page)
      }
    }
    if (this.undo.length > UNDO_KEEP) {
      const cut = this.undo.length - UNDO_KEEP
      this.undoFloor = Math.max(this.undoFloor, this.undo[cut - 1].seq)
      this.undo = this.undo.slice(cut)
    }
  }

  /** Rows moved (added on top, taken out, cleared): every page is sealed again. */
  private rowsMoved(): void {
    this.sealed = 0
    this.summaries = []
    this.dirty.clear()
    this.resident = []
    this.dropFrom = 0
    this.undo = []
    this.undoFloor = this.seq
  }

  /** Seal full pages, keeping at least a page of rows in the tail. */
  private seal(): void {
    const length = this.state.timeline.length
    while (length - (this.sealed + 1) * TIMELINE_PAGE_ROWS >= TIMELINE_PAGE_ROWS) {
      const page = this.sealed
      this.sealed++
      this.summaries[page] = this.summaryOf(page)
      this.dirty.add(page)
      this.touch(page)
    }
  }

  private summaryOf(page: number): TimelinePageSummary {
    const from = page * TIMELINE_PAGE_ROWS
    return summarizeRows(this.pageRows(page), from)
  }

  /** A resident page's rows (every one loaded). */
  private pageRows(page: number): TimelineItem[] {
    const from = page * TIMELINE_PAGE_ROWS
    return this.state.timeline.slice(from, from + TIMELINE_PAGE_ROWS) as TimelineItem[]
  }

  /** Mark `page` as just used. */
  private touch(page: number): void {
    this.resident = [...this.resident.filter((p) => p !== page), page]
    this.peakResident = Math.max(this.peakResident, this.resident.length)
  }

  private async readPage(page: number): Promise<TimelineItem[]> {
    const [got] = await this.store.loadPages([page])
    if (!got) throw new Error(`timeline page ${page} is missing`)
    return JSON.parse(got.rows) as TimelineItem[]
  }

  /** Unload clean sealed pages past the resident budget (least recently used first). */
  private evict(): void {
    // Not stored: every row stays in memory.
    if (this.broken) return
    while (this.resident.length > RESIDENT_PAGES) {
      const victim = this.resident.find((p) => !this.dirty.has(p))
      if (victim === undefined) return
      this.resident = this.resident.filter((p) => p !== victim)
      const from = victim * TIMELINE_PAGE_ROWS
      this.state = reducer(this.state, {
        type: 'rows-unloaded',
        from,
        to: from + TIMELINE_PAGE_ROWS
      })
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.closed) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, FLUSH_DELAY_MS)
    this.flushTimer.unref?.()
  }

  /**
   * Write the dirty pages and the checkpoint in one transaction. Without the
   * checkpoint (`withCheckpoint` false, along a long run): the stored one is
   * deleted, as the pages are now ahead of it (replaying its later events onto
   * them would apply some twice); the next write with one stores it again.
   */
  private async flushNow(withCheckpoint = true): Promise<void> {
    if (!this.checkpointDirty && this.dirty.size === 0 && this.dropFrom === null) return
    if (this.broken) return
    const pages = [...this.dirty]
      .filter((p) => p < this.sealed)
      .sort((a, b) => a - b)
      .map((page) => {
        const rows = this.pageRows(page)
        return {
          page,
          startRow: page * TIMELINE_PAGE_ROWS,
          endRow: page * TIMELINE_PAGE_ROWS + rows.length,
          rows: JSON.stringify(rows),
          summary: JSON.stringify(this.summaries[page]),
          searchText: pageSearchText(rows)
        }
      })
    const checkpoint = withCheckpoint
      ? {
          version: TIMELINE_PROJECTION_VERSION,
          seq: this.seq,
          data: JSON.stringify({
            sealed: this.sealed,
            state: encodeTimelineState(this.state, this.sealed * TIMELINE_PAGE_ROWS)
          } satisfies CheckpointData)
        }
      : null
    try {
      await this.store.save({ dropPagesFrom: this.dropFrom, pages, checkpoint })
    } catch (err) {
      this.onError('saving the timeline projection failed; it is rebuilt on the next open', err)
      this.broken = true
    }
    this.dirty.clear()
    this.dropFrom = null
    this.checkpointDirty = !withCheckpoint
    this.checkpointDropped = !withCheckpoint
    this.evict()
  }
}
