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
import { createHash } from 'node:crypto'
import {
  CHAT_HISTORY_DISPLAY_VERSION,
  CHAT_HISTORY_PAGE_MAX_BYTES,
  chatRowDetailIdentity,
  CHAT_TOOL_DETAIL_CHARS,
  type ChatToolDetailChunk,
  type ChatHistoryDisplay,
  type ChatRowDetailRef,
  type ChatToolSearchResult,
  jsonByteLength,
  utf8Length,
  type AgentEvent
} from '@slayzone/terminal-contracts'
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
export { packTimelineOpen } from '../../shared/chat-open-wire'
import {
  pageSearchText,
  searchableText,
  summarizeRows,
  type TimelinePageSummary
} from '../../shared/timeline-summary'
import type { BufferedEvent } from '../chat-events-store'
import { historyReadTurns } from '../history-turns'
import type { TimelineCheckpointRow, TimelineWrite } from '../chat-timeline-store'
import type { TimelineRecordStore } from './chat-timeline-records'
import { HydrateScan, type HydrateCheckpoint } from './chat-hydrate-scan'
import { hiddenActivityTextRows, previewTimelineRow } from './chat-tool-preview'
import { isRenderable } from '../../shared/chat-presentation'

export const TIMELINE_PAGE_ROWS = 256
/** Smaller wire pages reuse the stored rows and indexes. */
const WINDOW_PAGE_ROWS = 8
const WINDOW_PAGE_BUDGET = 96 * 1024
/** Sealed pages kept in memory besides the tail, most recently used. */
const RESIDENT_PAGES = 8
/** Row changes remembered, so rows can be served as they were at an earlier seq. */
const UNDO_KEEP = 4096
const FLUSH_DELAY_MS = 1500
const TOOL_DETAIL_CACHE_CHARS = 4 * 1024 * 1024
const TOOL_DETAIL_CACHE_MS = 10_000
/** Events folded per step of a long run (a rebuild): pages written + unloaded between steps. */
const FOLD_CHUNK = 256
/**
 * Encoded rows one store write carries at most (one page always): a flush of many
 * pages goes out in slices, each in its own turn of the process's history work
 * (2026-11-14: ~60 chats restoring at once, every dirty page in one synchronous
 * write per chat, stalled the computer 1–11 s).
 */
export const TIMELINE_FLUSH_SLICE_BYTES = 1024 * 1024
/** Where the projection persists (the tab's rows of `chat-timeline-store.ts`). */
export interface TimelineProjectionStore {
  /** Computer-local raw records: decoding/encoding can run in a projection worker. */
  records?: TimelineRecordStore
  loadCheckpoint(): Promise<TimelineCheckpointRow | null>
  loadPages(pages: readonly number[]): Promise<Array<{ page: number; rows: string }>>
  loadSummaries(): Promise<Array<{ page: number; summary: string }>>
  save(write: TimelineWrite): Promise<void>
  searchPages(needleLower: string): Promise<number[]>
  /** Throw the stored projection away (the next open rebuilds it from the events). */
  discard(): Promise<void>
}

export type TimelineProjectionHandle = Pick<
  TimelineProjection,
  | 'feed'
  | 'finish'
  | 'apply'
  | 'openSnapshot'
  | 'pagesAsOf'
  | 'toolDetail'
  | 'searchPages'
  | 'searchToolMatches'
  | 'flush'
  | 'close'
  | 'usable'
>
export interface TimelineProjectionStart {
  from: number
  hydrate?: HydrateCheckpoint
  checkpointMiss:
    | 'checkpoint-none'
    | 'checkpoint-version'
    | 'checkpoint-ahead'
    | 'checkpoint-other'
    | null
}

export type BeginTimelineProjection = (
  opts: Parameters<typeof TimelineProjection.begin>[0]
) => Promise<TimelineProjectionStart & { projection: TimelineProjectionHandle }>

/**
 * A tab's saved events as the projection reads them on open: `lastSeq` (its
 * newest event, -1: none) and the events after a seq, a page at a time (the caller
 * lets the event loop run between pages). An array is one in memory (tests).
 */
export interface TimelineHistorySource {
  lastSeq: number
  pages(afterSeq: number): AsyncIterable<readonly BufferedEvent[]>
}

/** An in-memory history as a {@link TimelineHistorySource}. */
export function historyOfEvents(history: readonly BufferedEvent[]): TimelineHistorySource {
  return {
    lastSeq: history.length > 0 ? history[history.length - 1].seq : -1,
    async *pages(afterSeq) {
      const after = history.filter((b) => b.seq > afterSeq)
      if (after.length > 0) yield after
    }
  }
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
  /** The requesting client opted into large tool result previews. */
  toolPreviews?: true
  displaySettings?: typeof CHAT_HISTORY_DISPLAY_VERSION
  windowed?: true
}

/**
 * Rows of pages as of an earlier seq, or `expired` (rows moved / too old: open
 * again). One answer carries at most a page budget of rows (the first page always
 * fits): `omitted` lists the pages asked for that did not fit — ask again.
 */
export type TimelinePagesResult =
  | {
      expired: false
      pages: Array<{ page: number; from: number; rows: TimelineItem[] }>
      /** Pages asked for and not (completely) in this answer: ask again. */
      omitted?: number[]
      /**
       * Asked from a row on (`startRow`): the answer ended INSIDE a page, which is the
       * first of `omitted`; ask again from this row (absolute). Absent: the answered
       * pages are complete.
       */
      next?: number
    }
  | { expired: true }

interface CheckpointData {
  sealed: number
  state: string
  hydrate: HydrateCheckpoint
}

function windowSummaries(
  stored: readonly TimelinePageSummary[],
  timeline: Readonly<TimelineRows>,
  tailFrom: number
): TimelinePageSummary[] {
  const out: TimelinePageSummary[] = []
  for (const [page, summary] of stored.entries()) {
    const from = page * TIMELINE_PAGE_ROWS
    for (let offset = 0; offset < TIMELINE_PAGE_ROWS; offset += WINDOW_PAGE_ROWS) {
      const start = from + offset
      const end = start + WINDOW_PAGE_ROWS
      const contains = ({ row }: { row: number }) => row >= start && row < end
      out.push({
        users: summary.users.filter(contains),
        ends: summary.ends.filter(contains),
        branches: summary.branches.filter(contains),
        files: summary.files.filter(contains),
        boundaries: summary.boundaries.filter((row) => row >= start && row < end),
        asks: summary.asks.filter(contains),
        rootRows:
          Math.floor(((offset + WINDOW_PAGE_ROWS) * summary.rootRows) / TIMELINE_PAGE_ROWS) -
          Math.floor((offset * summary.rootRows) / TIMELINE_PAGE_ROWS)
      })
    }
  }
  for (let start = out.length * WINDOW_PAGE_ROWS; start < tailFrom; start += WINDOW_PAGE_ROWS) {
    const rows = timeline.slice(start, start + WINDOW_PAGE_ROWS) as TimelineItem[]
    out.push(summarizeRows(rows, start))
  }
  return out
}

export class TimelineProjection {
  private state: ChatTimelineState
  private seq = -1
  private hydrateScan = new HydrateScan()
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
  private discarding: Promise<void> | null = null
  private peakResident = 0
  /** The stored checkpoint was deleted by a write ahead of it (none stored yet since). */
  private checkpointDropped = false
  /** Opened to rebuild (`begin`), until `finish`. */
  private rebuilding = false
  /** Reuse encoded data during a chunked read, one short-lived payload per chat. */
  private detailTransfer: {
    seq: number
    row: number
    key: string
    json: string
    revision: string
    timer: ReturnType<typeof setTimeout>
  } | null = null

  private constructor(
    private readonly store: TimelineProjectionStore,
    private readonly agentStartedTurns: boolean,
    private readonly onError: (what: string, err: unknown) => void,
    /** Bytes of rows one `pagesAsOf` answer carries, at most (the first page always fits). */
    private readonly pageBudgetBytes: number,
    /** Encoded rows one store write carries, at most (one page always). */
    private readonly flushSliceBytes: number
  ) {
    this.state = initialState({ agentStartedTurns })
  }

  /**
   * The projection of a tab whose saved events are `history` (all of them, in
   * seq order): from its checkpoint when one fits (only the events after it are
   * read), else rebuilt — page by page, never the whole history in memory.
   */
  static async open(opts: {
    store: TimelineProjectionStore
    history: readonly BufferedEvent[] | TimelineHistorySource
    agentStartedTurns: boolean
    onError?: (what: string, err: unknown) => void
    /** Defaults to {@link CHAT_HISTORY_PAGE_MAX_BYTES}. */
    pageBudgetBytes?: number
    /** Defaults to {@link TIMELINE_FLUSH_SLICE_BYTES}. */
    flushSliceBytes?: number
  }): Promise<TimelineProjection> {
    const history = 'pages' in opts.history ? opts.history : historyOfEvents(opts.history)
    const { projection, from } = await TimelineProjection.begin({
      ...opts,
      lastSeq: history.lastSeq
    })
    for await (const page of history.pages(from)) await projection.feed(page)
    await projection.finish()
    return projection
  }

  /**
   * Open in steps, for a caller that reads the history anyway (a hydrate): the
   * projection from its checkpoint when one fits a history whose newest event is
   * `lastSeq`, else ready to rebuild. Then `feed` it the saved events after `from`
   * (more are skipped), in seq order, and `finish`.
   */
  static async begin(opts: {
    store: TimelineProjectionStore
    lastSeq: number
    agentStartedTurns: boolean
    onError?: (what: string, err: unknown) => void
    pageBudgetBytes?: number
    flushSliceBytes?: number
  }): Promise<TimelineProjectionStart & { projection: TimelineProjection }> {
    const p = new TimelineProjection(
      opts.store,
      opts.agentStartedTurns,
      opts.onError ?? ((what, err) => console.error(`[chat-timeline] ${what}:`, err)),
      opts.pageBudgetBytes ?? CHAT_HISTORY_PAGE_MAX_BYTES,
      opts.flushSliceBytes ?? TIMELINE_FLUSH_SLICE_BYTES
    )
    // Storage metadata can itself take bounded history turns. Do not hold a
    // scheduler slot across those awaits (the compatibility path shares it).
    const checkpointMiss = await p.restore(opts.lastSeq)
    if (!checkpointMiss) {
      return { projection: p, from: p.seq, checkpointMiss, hydrate: p.hydrateScan.checkpoint() }
    }
    // Rebuild: every event, every page written again.
    p.rebuilding = true
    p.state = initialState({ agentStartedTurns: p.agentStartedTurns })
    p.seq = -1
    p.sealed = 0
    p.summaries = []
    p.dropFrom = 0
    if (opts.lastSeq < 0) p.checkpointDirty = true
    return { projection: p, from: -1, checkpointMiss }
  }

  /** Saved events of the history being opened, in seq order (those already folded in are skipped). */
  feed(entries: readonly BufferedEvent[]): Promise<void> {
    // Storage can yield to a timed flush while rebuilding. Both must share the
    // same chain, or one save can clear dirty pages created during another save.
    return this.enqueue(async () => {
      try {
        const fresh = entries.filter((b) => b.seq > this.seq)
        if (fresh.length > 0) await this.applyRun(fresh)
      } catch (err) {
        this.fail(err)
        throw err
      }
    })
  }

  /** The opening is done: a rebuild writes everything out; a restore stores a checkpoint again if pages went out. */
  async finish(): Promise<void> {
    // Pages went out along the way (the checkpoint with them): store one again.
    try {
      if (this.rebuilding || this.checkpointDropped) await this.flush()
      this.rebuilding = false
    } catch (err) {
      this.fail(err)
      throw err
    }
  }

  /**
   * Fold a long run of events in (open: a rebuild, or the events after the
   * checkpoint) a chunk at a time, writing pages out as it goes: memory holds
   * the tail and the budget of pages, never the whole history. Those writes
   * carry no checkpoint (it covers the whole history's indexes: one per run,
   * by the caller).
   */
  private async applyRun(entries: readonly BufferedEvent[]): Promise<void> {
    // A chunk is one step of the process's history work: dozens of chats opening at
    // once fold about one chunk per loop turn in total.
    const job = historyReadTurns.job()
    for (let i = 0; i < entries.length; i += FOLD_CHUNK) {
      await job.step(() => this.applyBatch(entries.slice(i, i + FOLD_CHUNK)))
      await this.flushIfOverBudget(false)
    }
  }

  /** Over the page budget (changes to many old pages): write them out now, then unload. */
  private async flushIfOverBudget(withCheckpoint = true): Promise<void> {
    if (this.resident.length > RESIDENT_PAGES) await this.flushNow(withCheckpoint)
  }

  /** From the stored checkpoint, when it fits these events. */
  private async restore(lastSeq: number): Promise<TimelineProjectionStart['checkpointMiss']> {
    try {
      const cp = await historyReadTurns.take(() => this.store.loadCheckpoint())
      if (!cp) return 'checkpoint-none'
      // 25.1 used the same reducer rows, summaries and hydrate scan. Only its
      // index encoding differs. Other versions need an explicit compatibility proof.
      const legacyIndex = cp.version === '25.1'
      if (!legacyIndex && cp.version !== TIMELINE_PROJECTION_VERSION) return 'checkpoint-version'
      if (cp.seq > lastSeq) return 'checkpoint-ahead'
      const data = JSON.parse(cp.data) as CheckpointData
      if (data.hydrate?.version !== 1 || !Array.isArray(data.hydrate.messages))
        return 'checkpoint-other'
      const hydrate = new HydrateScan(data.hydrate)
      const state = decodeTimelineState(data.state, legacyIndex ? '25' : undefined)
      if (state.agentStartedTurns !== this.agentStartedTurns) return 'checkpoint-other'
      const summaries = await this.store.loadSummaries()
      if (summaries.length !== data.sealed || summaries.some((s, i) => s.page !== i))
        return 'checkpoint-other'
      this.state = state
      this.hydrateScan = hydrate
      this.checkpointDirty = legacyIndex
      this.seq = cp.seq
      this.sealed = data.sealed
      this.summaries = summaries.map((s) => JSON.parse(s.summary) as TimelinePageSummary)
      this.undoFloor = cp.seq
      return null
    } catch (err) {
      this.onError('checkpoint unreadable, rebuilding', err)
      return 'checkpoint-other'
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
  apply(entry: BufferedEvent): Promise<void> {
    return this.enqueue(async () => {
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
  openSnapshot(toolPreviewInstance?: string, display?: ChatHistoryDisplay): Promise<TimelineOpen> {
    return this.enqueue(async () => {
      if (this.failed) throw new Error('the timeline projection failed')
      const storedTailFrom = this.sealed * TIMELINE_PAGE_ROWS
      const windowed = !!toolPreviewInstance && display?.windowed === true
      let tailFrom = windowed
        ? Math.floor(
            Math.max(0, this.state.timeline.length - WINDOW_PAGE_ROWS) / WINDOW_PAGE_ROWS
          ) * WINDOW_PAGE_ROWS
        : storedTailFrom
      if (windowed) {
        // A cluster of sub-agent children can fill the entire small window.
        // Keep its latest visible root when it is still in the resident tail.
        for (let row = this.state.timeline.length - 1; row >= storedTailFrom; row--) {
          const item = this.state.timeline[row]
          if (!item || item.parentToolUseId != null || !isRenderable(item)) continue
          tailFrom = Math.min(tailFrom, Math.floor(row / WINDOW_PAGE_ROWS) * WINDOW_PAGE_ROWS)
          break
        }
      }
      const hideMessages = display?.hideActivityMessages || display?.hideActivities
      const hiddenText =
        toolPreviewInstance && hideMessages
          ? hiddenActivityTextRows(this.state.timeline, tailFrom, 0)
          : undefined
      const result = this.state.lastResult
      const wireState =
        toolPreviewInstance && (hideMessages || windowed) && result?.copyText
          ? { ...this.state, lastResult: { ...result, copyText: null } }
          : this.state
      return {
        version: TIMELINE_PROJECTION_VERSION,
        seq: this.seq,
        epoch: this.state.rowsEpoch,
        pageRows: windowed ? WINDOW_PAGE_ROWS : TIMELINE_PAGE_ROWS,
        state: encodeTimelineState(
          wireState,
          tailFrom,
          toolPreviewInstance
            ? (row, index) =>
                previewTimelineRow(
                  row,
                  index,
                  this.state.rowsEpoch,
                  toolPreviewInstance,
                  display,
                  hiddenText?.has(index),
                  index < this.state.turnStart
                )
            : undefined
        ),
        summaries: windowed
          ? windowSummaries(this.summaries, this.state.timeline, tailFrom)
          : this.summaries,
        ...(windowed ? { windowed: true as const } : {}),
        ...(toolPreviewInstance
          ? { toolPreviews: true as const, displaySettings: CHAT_HISTORY_DISPLAY_VERSION }
          : {})
      }
    })
  }

  /**
   * The rows of `pages` as they were after event `asOfSeq` (a client's newest,
   * maybe behind the hub). Expired when rows moved since (`epoch`) or the
   * changes since are no longer remembered.
   *
   * An answer carries at most the byte budget of rows. Without `startRow` (older
   * clients) whole pages: the first always fits, however large. With `startRow`
   * (absolute row: where the first page asked is to start) the budget cuts between
   * ROWS — one row always fits — so a page larger than the budget comes in slices:
   * `next` names the row to ask from, its page first in `omitted`.
   */
  pagesAsOf(
    pages: readonly number[],
    asOfSeq: number,
    epoch: number,
    startRow?: number,
    toolPreviewInstance?: string,
    display?: ChatHistoryDisplay
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
      const windowed = !!toolPreviewInstance && display?.windowed === true && startRow !== undefined
      const pageRows = windowed ? WINDOW_PAGE_ROWS : TIMELINE_PAGE_ROWS
      const pageCount = windowed ? Math.floor(this.state.timeline.length / pageRows) : this.sealed
      const budget = windowed
        ? Math.min(WINDOW_PAGE_BUDGET, this.pageBudgetBytes)
        : this.pageBudgetBytes
      const wanted = pages.filter((p) => p >= 0 && p < pageCount)
      // Resolve historical values before choosing the byte boundary. A late
      // result may have shrunk a row; sizing today's value would overfill an
      // answer after undo. Newest first, so the oldest applicable value wins.
      const previous = new Map<number, Map<number, TimelineItem>>()
      for (let k = this.undo.length - 1; k >= 0 && this.undo[k].seq > asOfSeq; k--) {
        const u = this.undo[k]
        const page = Math.floor(u.row / TIMELINE_PAGE_ROWS)
        let rows = previous.get(page)
        if (!rows) previous.set(page, (rows = new Map()))
        rows.set(u.row % TIMELINE_PAGE_ROWS, u.prev)
      }
      const restore = (page: number, rows: TimelineItem[]): TimelineItem[] => {
        // Both resident slices and parsed stored pages are private arrays.
        for (const [index, row] of previous.get(page) ?? []) rows[index] = row
        return rows
      }
      const out: Array<{ page: number; from: number; rows: TimelineItem[] }> = []
      const omitted: number[] = []
      let bytes = 0
      let next: number | undefined
      try {
        if (startRow !== undefined) {
          // Adjacent wire pages often reuse one physical page.
          let cachedPage = -1
          let cachedRows: TimelineItem[] = []
          let hiddenText: ReadonlySet<number> | undefined
          for (const page of wanted) {
            if (omitted.length > 0) {
              omitted.push(page)
              continue
            }
            const from = page * pageRows
            const physicalPage = Math.floor(from / TIMELINE_PAGE_ROWS)
            const storedFrom = physicalPage * TIMELINE_PAGE_ROWS
            if (cachedPage !== physicalPage) {
              const resident = physicalPage >= this.sealed || this.resident.includes(physicalPage)
              cachedRows = restore(
                physicalPage,
                resident ? this.pageRows(physicalPage) : await this.readPage(physicalPage)
              )
              hiddenText =
                display?.hideActivityMessages || display?.hideActivities
                  ? hiddenActivityTextRows(cachedRows, 0, storedFrom)
                  : undefined
              cachedPage = physicalPage
            }
            const skip = startRow > from && startRow < from + pageRows ? startRow - from : 0
            const taken: TimelineItem[] = []
            for (let k = skip; k < pageRows; k++) {
              const item = cachedRows[from + k - storedFrom]
              const row = toolPreviewInstance
                ? previewTimelineRow(
                    item,
                    from + k,
                    epoch,
                    toolPreviewInstance,
                    display,
                    hiddenText?.has(from + k),
                    asOfSeq === this.seq && from + k < this.state.turnStart
                  )
                : item
              const size = jsonByteLength(row) + 1
              if ((out.length > 0 || taken.length > 0) && bytes + size > budget) break
              bytes += size
              taken.push(row)
            }
            if (taken.length > 0) out.push({ page, from: from + skip, rows: taken })
            if (skip + taken.length < pageRows) {
              // Not (completely) answered: asked again, from where it stopped.
              omitted.push(page)
              if (taken.length > 0) next = from + skip + taken.length
            }
          }
        } else
          for (const page of wanted) {
            if (omitted.length > 0) {
              omitted.push(page)
              continue
            }
            // In memory, or as stored (a page leaves memory only once stored: current).
            const resident = this.resident.includes(page)
            let rows = resident ? this.pageRows(page) : null
            const stored = resident ? null : await this.readStoredPage(page)
            if (previous.has(page))
              rows = restore(page, rows ?? (JSON.parse(stored!) as TimelineItem[]))
            const size = rows ? jsonByteLength(rows) : utf8Length(stored!)
            if (out.length > 0 && bytes + size > this.pageBudgetBytes) {
              omitted.push(page)
              continue
            }
            bytes += size
            out.push({
              page,
              from: page * TIMELINE_PAGE_ROWS,
              rows: rows ?? (JSON.parse(stored!) as TimelineItem[])
            })
          }
      } catch (err) {
        // The client opens again (from the events: this one is no longer served).
        this.fail(err)
        return { expired: true }
      }
      return {
        expired: false,
        pages: out,
        ...(omitted.length > 0 ? { omitted } : {}),
        ...(next !== undefined ? { next } : {})
      }
    })
  }

  /** Full row detail, guarded by row epoch, identity and a revision across chunks. */
  toolDetail(
    ref: ChatRowDetailRef,
    offset: number,
    revision?: string
  ): Promise<ChatToolDetailChunk> {
    return this.enqueue(async () => {
      if (
        this.failed ||
        ref.epoch !== this.state.rowsEpoch ||
        ref.row >= this.state.timeline.length
      )
        return null
      const key = chatRowDetailIdentity(ref)
      const cached = this.detailTransfer
      let json: string
      let hash: string
      if (cached?.seq === this.seq && cached.row === ref.row && cached.key === key) {
        json = cached.json
        hash = cached.revision
      } else {
        const page = Math.floor(ref.row / TIMELINE_PAGE_ROWS)
        const row =
          this.state.timeline[ref.row] ?? (await this.readPage(page))[ref.row % TIMELINE_PAGE_ROWS]
        if ('toolUseId' in ref) {
          if (row?.kind !== 'tool' || row.invocation.id !== ref.toolUseId) return null
          const visible = ref.preview
            ? previewTimelineRow(row, ref.row, ref.epoch, ref.instance)
            : row
          if (visible.kind !== 'tool') return null
          json = JSON.stringify(visible.invocation)
        } else if (ref.kind === 'result-copy') {
          if (row?.kind !== 'result' || row.timestamp !== ref.timestamp || !row.copyText)
            return null
          json = JSON.stringify(row.copyText)
        } else {
          if (
            row?.kind !== ref.kind ||
            row.messageId !== ref.messageId ||
            row.blockOrdinal !== ref.blockOrdinal
          )
            return null
          json = JSON.stringify(row.text)
        }
        hash = createHash('sha256').update(json).digest('hex')
      }
      if ((revision === undefined ? offset !== 0 : revision !== hash) || offset >= json.length)
        return null
      let end = Math.min(offset + CHAT_TOOL_DETAIL_CHARS, json.length)
      // Keep surrogate pairs together across chunks.
      const lastChar = json.charCodeAt(end - 1)
      if (end < json.length && lastChar >= 0xd800 && lastChar <= 0xdbff) end--
      this.clearDetailTransfer()
      if (end < json.length && json.length <= TOOL_DETAIL_CACHE_CHARS) {
        const timer = setTimeout(() => this.clearDetailTransfer(), TOOL_DETAIL_CACHE_MS)
        timer.unref?.()
        this.detailTransfer = {
          seq: this.seq,
          row: ref.row,
          key,
          json,
          revision: hash,
          timer
        }
      }
      return { data: json.slice(offset, end), revision: hash, next: end < json.length ? end : null }
    })
  }

  /**
   * Sealed pages that may hold `query` (a superset: the caller checks the rows
   * it loads). Pages changed since they were written are always in.
   */
  searchPages(query: string): Promise<number[]> {
    return this.enqueue(() => this.findSearchPages(query.toLowerCase()))
  }

  /** Exact matches for deferred text and tool input, using their originals. */
  searchToolMatches(query: string, caseSensitive: boolean): Promise<ChatToolSearchResult> {
    return this.enqueue(async () => {
      const pages = await this.findSearchPages(query.toLowerCase())
      const toolUseIds = new Set<string>()
      const needle = caseSensitive ? query : query.toLowerCase()
      if (!needle || this.failed) return { pages, toolUseIds: [] }
      const textRows: number[] = []
      const windowedPages = new Set<number>()
      const inspect = (rows: Readonly<TimelineRows>, from: number) => {
        rows.forEach((row, offset) => {
          if (!row) return
          const text = searchableText(row)
          if (!(caseSensitive ? text : text.toLowerCase()).includes(needle)) return
          windowedPages.add(Math.floor((from + offset) / WINDOW_PAGE_ROWS))
          if (row.kind === 'tool') toolUseIds.add(row.invocation.id)
          else if (row.kind === 'thinking' || row.kind === 'text') textRows.push(from + offset)
        })
      }
      for (const page of pages) {
        inspect(
          this.resident.includes(page) ? this.pageRows(page) : await this.readPage(page),
          page * TIMELINE_PAGE_ROWS
        )
      }
      const tailFrom = this.sealed * TIMELINE_PAGE_ROWS
      inspect(this.state.timeline.slice(tailFrom), tailFrom)
      return {
        pages,
        windowedPages: [...windowedPages],
        toolUseIds: [...toolUseIds],
        ...(textRows.length ? { textMatches: { epoch: this.state.rowsEpoch, rows: textRows } } : {})
      }
    })
  }

  private async findSearchPages(needle: string): Promise<number[]> {
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
    await this.discarding
    this.clearDetailTransfer()
    this.closed = true
  }

  // ---- internals ----

  private clearDetailTransfer(): void {
    if (!this.detailTransfer) return
    clearTimeout(this.detailTransfer.timer)
    this.detailTransfer = null
  }

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
    this.discarding = this.store
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
    for (const entry of entries) this.hydrateScan.add(entry.event)
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
    return JSON.parse(await this.readStoredPage(page)) as TimelineItem[]
  }

  /** A stored page's rows, as stored (JSON). */
  private async readStoredPage(page: number): Promise<string> {
    const [got] = await this.store.loadPages([page])
    if (!got) throw new Error(`timeline page ${page} is missing`)
    return got.rows
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
      void this.flush().catch((err: unknown) => this.fail(err))
    }, FLUSH_DELAY_MS)
    this.flushTimer.unref?.()
  }

  /**
   * Write the dirty pages and the checkpoint. In slices of at most
   * `flushSliceBytes` of encoded rows (one page always), each its own store write
   * in its own turn of the process's history work — a chat whose rows moved rewrites
   * every page, and dozens of chats restore at once. Only the first slice drops
   * pages; every slice but the last deletes the stored checkpoint (the pages are now
   * ahead of it), so a write that fails or a process that dies half way leaves NO
   * checkpoint: the next open rebuilds, never restores onto pages it does not match.
   * Without the checkpoint (`withCheckpoint` false, along a long run) the last slice
   * deletes it too; the next write with one stores it again.
   */
  private async flushNow(withCheckpoint = true): Promise<void> {
    if (!this.checkpointDirty && this.dirty.size === 0 && this.dropFrom === null) return
    if (this.broken) return
    const dirty = [...this.dirty].filter((p) => p < this.sealed).sort((a, b) => a - b)
    let dropPagesFrom = this.dropFrom
    let next = 0
    const job = historyReadTurns.job()
    try {
      do {
        const write = await job.step(() => {
          const pages: TimelineWrite['pages'] = []
          let bytes = 0
          while (next < dirty.length && (pages.length === 0 || bytes < this.flushSliceBytes)) {
            const page = dirty[next]
            const rows = this.pageRows(page)
            const encoded = JSON.stringify(rows)
            if (pages.length > 0 && bytes + encoded.length > this.flushSliceBytes) break
            bytes += encoded.length
            next++
            pages.push({
              page,
              startRow: page * TIMELINE_PAGE_ROWS,
              endRow: page * TIMELINE_PAGE_ROWS + rows.length,
              rows: encoded,
              summary: JSON.stringify(this.summaries[page]),
              searchText: pageSearchText(rows)
            })
          }
          const last = next >= dirty.length
          const checkpoint =
            last && withCheckpoint
              ? {
                  version: TIMELINE_PROJECTION_VERSION,
                  seq: this.seq,
                  data: JSON.stringify({
                    sealed: this.sealed,
                    state: encodeTimelineState(this.state, this.sealed * TIMELINE_PAGE_ROWS),
                    hydrate: this.hydrateScan.checkpoint()
                  } satisfies CheckpointData)
                }
              : null
          return { dropPagesFrom, pages, checkpoint }
        })
        // The database owner schedules deletion/persistence independently. It
        // must not wait for a slot still held by this encoding turn.
        await this.store.save(write)
        dropPagesFrom = null
      } while (next < dirty.length)
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
