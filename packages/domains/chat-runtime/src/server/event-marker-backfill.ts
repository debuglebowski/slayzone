/**
 * Event-marker backfill (FU5 computer stalls): `event_markers` (storage.ts) is kept
 * exact by triggers for every row written since it exists, and a conversation created
 * since is covered from birth. A conversation saved BEFORE it holds unindexed rows, so
 * `prompts.summaries` keeps scanning all its events — the multi-second stalls this
 * index removes — until this background pass has indexed it:
 *
 * - Small slices (≈20 ms / a byte budget cut from record-header sizes) with a pause
 *   between them, so the computer's event loop never stalls on it. Each slice is ONE
 *   transaction; the conversation is covered in the transaction of its last slice
 *   (rows appended meanwhile already carry markers; deleted ones took theirs along).
 * - Checkpointed per conversation (`maintenance_cursors['event-markers-v1:<id>']`), so
 *   a restart resumes where it stopped; idempotent (`INSERT OR IGNORE`).
 * - Read-only on events: no quiescing, no ownership checks needed — the index is
 *   derived and every writer keeps it exact.
 * - Chats a summary just had to scan in full (`prioritize`) go first.
 * - Done = no uncovered conversation left (`uncoveredMarkerConversations`), the one
 *   source of truth: a store restored from an older backup simply runs the pass again.
 *   A pass reads that list once, and again only when it has worked through it.
 * - A conversation that fails (anything but a storage-fatal error, which stops the
 *   pass for a later retry) is skipped for the rest of the pass and counted; the
 *   next pass tries it again. One bad chat never holds up the others.
 *
 * Progress goes to the computer log: counts only, never content.
 */
import { isStorageFatal } from '@slayzone/platform/isolation'
import type { ChatStorage } from './storage'

/** Checkpoint key prefix (`maintenance_cursors`). */
export const EVENT_MARKER_BACKFILL = 'event-markers-v1'

export interface EventMarkerBackfillReport {
  /** Conversations covered by this pass. */
  conversations: number
  /** Markers written (rows of a marker kind found). */
  markers: number
  /** Stored event bytes walked. */
  bytes: number
  /** Conversations that failed and were skipped for this pass (retried by the next). */
  failed: number
}

export interface EventMarkerBackfillOptions {
  storage: ChatStorage
  /** Start on its own after boot (and retry an unfinished pass). Default true. */
  automatic?: boolean
  /** Computer log line. Default: console. */
  log?(line: string): void
  /** Pause between slices. Default: a timer. */
  sleep?(ms: number): Promise<void>
  now?(): number
  /** Work per slice (ms). Default 20. */
  sliceMs?: number
  /** Stored bytes walked per transaction at most (one row may exceed it). Default 4 MiB. */
  sliceBytes?: number
  /** Pause between slices (ms). Default 80 (≈20 % duty). */
  idleMs?: number
  /** First automatic run after boot (ms). Default 30 s. */
  startDelayMs?: number
  /** Retry of an unfinished pass (ms). Default 10 min. */
  retryMs?: number
}

const MiB = 1024 * 1024
const ROWS_PER_SLICE = 512

export function createEventMarkerBackfill(opts: EventMarkerBackfillOptions) {
  const store = opts.storage
  const log = opts.log ?? ((line: string) => console.log(line))
  const now = opts.now ?? Date.now
  const sliceMs = opts.sliceMs ?? 20,
    sliceBytes = opts.sliceBytes ?? 4 * MiB,
    idleMs = opts.idleMs ?? 80
  const budget = { maxEvents: ROWS_PER_SLICE, maxBytes: sliceBytes }
  let closed = false,
    pending: Promise<EventMarkerBackfillReport | null> | null = null,
    schedule: ReturnType<typeof setTimeout> | null = null
  /** Chats a summary is waiting on: indexed first. */
  const first = new Set<string>()
  // Every pause ends early on close(): a pass awaited by close() never waits on a timer.
  const sleepers = new Set<() => void>()
  const sleep = (ms: number): Promise<void> => {
    if (closed) return Promise.resolve()
    if (opts.sleep) return opts.sleep(ms)
    return new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer)
        sleepers.delete(wake)
        resolve()
      }
      const timer = setTimeout(wake, ms)
      sleepers.add(wake)
    })
  }
  const cursorKey = (id: string) => `${EVENT_MARKER_BACKFILL}:${id}`
  const markerCount = (): number =>
    store.compose(
      (raw) => (raw.prepare('SELECT count(*) AS n FROM event_markers').get() as { n: number }).n
    )

  /** One conversation, slice by slice: true = covered, false = stopped (checkpointed). */
  async function index(id: string, report: EventMarkerBackfillReport): Promise<boolean> {
    let seq = store.maintenanceCursor<number>(cursorKey(id)) ?? -1
    for (;;) {
      if (closed) return false
      const start = now()
      let done = false
      // Synchronous from here to the pause: one or more short transactions.
      do {
        const slice = store.backfillEventMarkers(id, seq, budget)
        seq = slice.through
        report.bytes += slice.bytes
        done = slice.done
      } while (!done && now() - start < sliceMs)
      if (done) {
        store.compose((raw) =>
          raw.prepare('DELETE FROM maintenance_cursors WHERE id=?').run(cursorKey(id))
        )
        return true
      }
      store.setMaintenanceCursor(cursorKey(id), seq)
      await sleep(idleMs)
    }
  }

  function runNow(): Promise<EventMarkerBackfillReport | null> {
    if (closed) return Promise.resolve(null)
    if (pending) return pending
    // The pass's work list, read once (and again only when it runs out).
    let queue = store.uncoveredMarkerConversations()
    if (queue.length === 0) return Promise.resolve(null)
    pending = (async () => {
      const report: EventMarkerBackfillReport = {
        conversations: 0,
        markers: 0,
        bytes: 0,
        failed: 0
      }
      const before = markerCount()
      const total = queue.length
      const skipped = new Set<string>()
      let complete = false
      log(`[event-marker-backfill] starting: ${total} conversations to index`)
      let lastLog = now()
      for (;;) {
        if (closed) break
        if (queue.length === 0) {
          // Worked through: anything still uncovered (not skipped) is new to this pass.
          const left = store.uncoveredMarkerConversations()
          queue = left.filter((id) => !skipped.has(id))
          if (queue.length === 0) {
            complete = left.length === 0
            break
          }
        }
        const firstAt = queue.findIndex((id) => first.has(id))
        const next = queue.splice(firstAt >= 0 ? firstAt : 0, 1)[0]!
        first.delete(next)
        let covered: boolean
        try {
          covered = await index(next, report)
        } catch (error) {
          // The machine's disk or database is broken: stop; the retry comes later.
          if (isStorageFatal(error)) throw error
          skipped.add(next)
          report.failed++
          log(
            `[event-marker-backfill] ${next} failed (${(error as Error | null)?.name ?? 'error'}); skipped for this pass`
          )
          continue
        }
        if (!covered) break
        report.conversations++
        log(`[event-marker-backfill] indexed ${next}`)
        if (now() - lastLog >= 30_000) {
          lastLog = now()
          log(
            `[event-marker-backfill] progress: ${report.conversations}/${total} conversations, ${(report.bytes / MiB).toFixed(1)} MiB walked`
          )
        }
        await sleep(idleMs)
      }
      report.markers = markerCount() - before
      const summary = `${report.conversations} conversations, ${report.markers} markers, ${(report.bytes / MiB).toFixed(1)} MiB walked, ${report.failed} failed`
      if (complete) log(`[event-marker-backfill] complete: ${summary}`)
      else log(`[event-marker-backfill] stopped (resumes later): ${summary}`)
      return report
    })().finally(() => {
      pending = null
    })
    return pending
  }

  function plan(delay: number) {
    if (closed || opts.automatic === false) return
    schedule = setTimeout(() => {
      schedule = null
      void runNow()
        .catch((error: unknown) => {
          console.error('[event-marker-backfill] pass failed; retrying later:', error)
        })
        .finally(() => {
          if (!closed && store.uncoveredMarkerConversations().length > 0)
            plan(opts.retryMs ?? 600_000)
        })
    }, delay)
    schedule.unref?.()
  }
  plan(opts.startDelayMs ?? 30_000)

  return {
    runNow,
    /** Index these conversations next (a summary had to scan them in full). */
    prioritize(conversationIds: readonly string[]) {
      for (const id of conversationIds) first.add(id)
    },
    /** Every conversation is covered. */
    done: () => store.uncoveredMarkerConversations().length === 0,
    async close() {
      closed = true
      if (schedule) clearTimeout(schedule)
      for (const wake of [...sleepers]) wake()
      await pending?.catch(() => undefined)
    }
  }
}
