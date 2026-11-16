/**
 * ONE DATABASE COMPACTION PER BURST OF ERASURES.
 *
 * Deleting rows does not remove their bytes from the SQLite file: older versions sit in
 * free pages, in the unused part of live pages and in WAL frames. `secure_delete=ON`
 * zeroes what a delete frees, but NOT the stale cell copies a b-tree page split or merge
 * leaves in a live page's unused area (measured: SQLite 3.53.4 left 13 copies of deleted
 * rows after random-order inserts with secure_delete on from the first write). Only a
 * full `VACUUM` rewrites every page, so an erasure is complete only after one ran,
 * followed by `wal_checkpoint(TRUNCATE)`.
 *
 * A VACUUM rewrites the whole file on the hub's single DB connection (seconds on a
 * few hundred MB). So jobs ask this scheduler instead of running one each:
 *  - inline (no `compaction` timing configured, and account erasure): the run starts
 *    now and the caller waits for it; it also covers every job already waiting.
 *  - deferred (`compaction: { quietMs, maxDelayMs }`): the run starts once no job has
 *    asked for `quietMs`, at most `maxDelayMs` after the first request. Each covered
 *    job is then resumed, and only that pass reports it complete.
 * A failed run (busy checkpoint, no disk space for the rebuild) is visible on its jobs
 * and retried with exponential backoff, never in a tight loop.
 *
 * A request covers only the job generations it names: work recorded after the run
 * started needs the next run (index.ts keeps the generations; this file only runs).
 */

export interface CompactionTiming {
  /** Start once no erasure asked for this long. */
  quietMs: number
  /** ...but never later than this after the first waiting request. */
  maxDelayMs: number
}

export interface CompactionRequest {
  jobId: string
  /** The hub database itself needs a VACUUM (not only the additional stores). */
  hub: boolean
  /** Compacts stores outside the hub database (diagnostics); VACUUMs only if needed. */
  additional?: () => Promise<void>
  /** Resumes a deferred job once its run is over (`ok`: the run succeeded). Absent
   *  for inline requests: their caller continues itself. */
  finalize?: (ok: boolean) => Promise<unknown>
}

export interface CompactionRunner {
  /** Hub database: VACUUM + WAL checkpoint(TRUNCATE). Throws when not achieved. */
  compactHub: () => Promise<void>
}

const FAILURE_BACKOFF_BASE_MS = 30_000
const FAILURE_BACKOFF_CAP_MS = 30 * 60_000

export function createCompactionScheduler(runner: CompactionRunner) {
  let waiting = new Map<string, CompactionRequest>()
  let waiters: Array<(ok: boolean) => void> = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let firstRequestAt = 0
  let running: Promise<void> | null = null
  let consecutiveFailures = 0
  let lastFailureAt = 0
  let lastRunOk = true
  const finalizing = new Set<Promise<unknown>>()

  async function runBatch(): Promise<void> {
    const batch = waiting,
      batchWaiters = waiters
    waiting = new Map()
    waiters = []
    firstRequestAt = 0
    let ok = true
    try {
      // Each distinct additional store once, then the hub, only if a job needs it.
      for (const compact of new Set([...batch.values()].map((r) => r.additional))) await compact?.()
      if ([...batch.values()].some((r) => r.hub)) await runner.compactHub()
      consecutiveFailures = 0
    } catch {
      ok = false
      consecutiveFailures++
      lastFailureAt = Date.now()
    }
    lastRunOk = ok
    for (const resolve of batchWaiters) resolve(ok)
    for (const request of batch.values()) {
      if (!request.finalize) continue
      const work = request
        .finalize(ok)
        .catch(() => undefined)
        .finally(() => finalizing.delete(work))
      finalizing.add(work)
    }
  }

  function start(): Promise<void> {
    if (timer) clearTimeout(timer)
    timer = null
    if (running) return running
    if (!waiting.size) return Promise.resolve()
    running = runBatch().finally(() => {
      running = null
      // Requests that arrived during the run: their own run, on their own schedule.
      if (waiting.size && !timer) arm(pendingTiming)
    })
    return running
  }

  let pendingTiming: CompactionTiming | null = null
  function arm(timing: CompactionTiming | null) {
    if (!timing) return
    const now = Date.now()
    if (!firstRequestAt) firstRequestAt = now
    let delay = Math.max(0, Math.min(timing.quietMs, firstRequestAt + timing.maxDelayMs - now))
    if (consecutiveFailures) {
      const backoff = Math.min(
        FAILURE_BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1),
        FAILURE_BACKOFF_CAP_MS
      )
      delay = Math.max(delay, lastFailureAt + backoff - now)
    }
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void start()
    }, delay)
    timer.unref?.()
  }

  return {
    /**
     * Inline (`timing` null): runs now, resolves `true` once a run covering this
     * request succeeded. Deferred: resolves when its run ends; `finalize` resumes it.
     */
    request(request: CompactionRequest, timing: CompactionTiming | null): Promise<boolean> {
      const merged = waiting.get(request.jobId)
      waiting.set(request.jobId, {
        ...request,
        hub: request.hub || (merged?.hub ?? false),
        finalize: request.finalize ?? merged?.finalize
      })
      const done = new Promise<boolean>((resolve) => waiters.push(resolve))
      if (timing) {
        pendingTiming = timing
        if (!running) arm(timing)
      } else if (running) {
        // The current run started before this request: chain the next one now.
        void running.then(() => start())
      } else void start()
      return done
    },
    /** Waiting for a run (scheduled, or chained behind the current one). */
    isWaiting(jobId: string): boolean {
      return waiting.has(jobId)
    },
    /** The last run failed: its jobs report it until a run succeeds. */
    lastRunFailed(): boolean {
      return consecutiveFailures > 0
    },
    /**
     * Run every waiting request now and wait for the resumed jobs, including runs
     * those jobs ask for (a job clears its worktree paths, then needs one more). Stops
     * after a failed run: its jobs wait for the backoff like any other retry.
     */
    async flush(): Promise<void> {
      for (;;) {
        if (running || waiting.size) {
          await (running ?? start())
          if (!lastRunOk) {
            await Promise.allSettled([...finalizing])
            return
          }
        } else if (finalizing.size) await Promise.allSettled([...finalizing])
        else return
      }
    },
    close() {
      if (timer) clearTimeout(timer)
      timer = null
    }
  }
}

export type CompactionScheduler = ReturnType<typeof createCompactionScheduler>
