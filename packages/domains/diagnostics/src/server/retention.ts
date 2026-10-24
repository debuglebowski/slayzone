import type { SlayzoneDb } from '@slayzone/platform'
import type { DiagnosticsConfig } from '../shared'
import {
  createFilesystemBlobFs,
  DEFAULT_MAX_BLOB_BYTES,
  pruneBlobs,
  type BlobFileSystem
} from './blob-retention'
import { getDiagnosticsBlobDir } from './diagnostics-store'

const HARD_EVENT_CAP = 200_000
const CHUNK_LIMIT = 10_000
const TICK_IDLE_MS = 60_000
const TICK_WORK_MS = 3_000

export interface RetentionDeps {
  getDb: () => SlayzoneDb | null
  getConfig: () => DiagnosticsConfig
  now?: () => number
  /**
   * Filesystem for payload-blob pruning. Injected for tests; production prunes the
   * dir the host bound via `bindDiagnosticsDbs({ blobDir })`.
   */
  blobFs?: BlobFileSystem
}

// Cheap row-count proxy. `SELECT COUNT(*)` scans an index over the entire
// table — on a multi-million row table that's seconds of work. rowid edges are
// O(log n) btree lookups: ~microseconds regardless of size.
// Accurate for FIFO log tables (insert + delete only, no updates).
async function approxRowCount(db: SlayzoneDb): Promise<number> {
  const row = (await db
    .prepare('SELECT MAX(rowid) AS hi, MIN(rowid) AS lo FROM diagnostics_events')
    .get()) as { hi: number | null; lo: number | null }
  if (row.hi == null || row.lo == null) return 0
  return row.hi - row.lo + 1
}

export async function runRetentionChunk(
  db: SlayzoneDb,
  config: DiagnosticsConfig,
  nowMs: number = Date.now()
): Promise<{ deleted: number; moreWork: boolean }> {
  const count = await approxRowCount(db)

  if (count > HARD_EVENT_CAP) {
    const limit = Math.min(count - HARD_EVENT_CAP, CHUNK_LIMIT)
    const res = await db
      .prepare(`
        DELETE FROM diagnostics_events
        WHERE id IN (SELECT id FROM diagnostics_events ORDER BY ts_ms ASC LIMIT ?)
      `)
      .run(limit)
    const deleted = Number(res.changes)
    await reclaimFreePages(db)
    return { deleted, moreWork: count - deleted > HARD_EVENT_CAP || deleted === CHUNK_LIMIT }
  }

  const cutoff = nowMs - config.retentionDays * 24 * 60 * 60 * 1000
  const res = await db
    .prepare(`
      DELETE FROM diagnostics_events
      WHERE id IN (
        SELECT id FROM diagnostics_events
        WHERE ts_ms < ?
        ORDER BY ts_ms ASC
        LIMIT ?
      )
    `)
    .run(cutoff, CHUNK_LIMIT)
  const deleted = Number(res.changes)
  if (deleted > 0) await reclaimFreePages(db)
  return { deleted, moreWork: deleted === CHUNK_LIMIT }
}

/**
 * Prune payload blobs alongside the event rows.
 *
 * Deleting event ROWS reclaims nothing on disk, so offloading canary screenshots to
 * `<storage>/diagnostics/` (see `payload-blobs.ts`) leaked without this: ~10 MB/week
 * measured, unbounded. Bounded by the same `retentionDays` as the rows — past which
 * a blob is unreferenced by construction — plus a hard size ceiling for the burst
 * case, where a driver fault fires the canary hundreds of times and every blob is
 * still "recent".
 *
 * Never throws: diagnostics housekeeping must not break the retention tick.
 */
export function runBlobRetention(
  config: DiagnosticsConfig,
  nowMs: number,
  blobFs?: BlobFileSystem
): { deleted: number; freedBytes: number; failed: number } {
  let fs = blobFs
  if (!fs) {
    const dir = getDiagnosticsBlobDir()
    // Unbound: this process has written no blobs, so there are none to prune.
    if (!dir) return { deleted: 0, freedBytes: 0, failed: 0 }
    fs = createFilesystemBlobFs(dir)
  }
  try {
    const result = pruneBlobs(fs, {
      cutoffMs: nowMs - config.retentionDays * 24 * 60 * 60 * 1000,
      maxTotalBytes: DEFAULT_MAX_BLOB_BYTES
    })
    if (result.failed > 0) {
      console.warn(`[diagnostics retention] ${result.failed} blob(s) could not be deleted`)
    }
    return result
  } catch (err) {
    // pruneBlobs isolates per-file fs errors itself; this is the last resort.
    console.error('[diagnostics retention] blob prune failed:', err)
    return { deleted: 0, freedBytes: 0, failed: 0 }
  }
}

// Free disk pages back to the filesystem. No-op unless the DB was created
// with `auto_vacuum=INCREMENTAL` (set in the diagnostics worker startup). For
// DBs rotated by self-heal, the fresh DB has it on. SlayzoneDb has no pragma()
// accessor, so the pragma runs as a statement through exec().
async function reclaimFreePages(db: SlayzoneDb): Promise<void> {
  try {
    await db.exec('PRAGMA incremental_vacuum')
  } catch {
    // Some DB states (e.g. open transaction elsewhere) reject vacuum. Best-effort.
  }
}

let currentTimer: NodeJS.Timeout | null = null
// The running scheduler's deps; null when stopped. A tick from a stopped or
// replaced scheduler compares against this and does not reschedule.
let currentDeps: RetentionDeps | null = null
let inFlight: Promise<void> | null = null

/**
 * Prune this process's diagnostics DB (rows + payload blobs) on a timer.
 *
 * Exactly ONE process per diagnostics DB file runs this: the Electron host for its
 * file — which its supervised hub writes too — and an unsupervised hub for its own.
 * Two pruners on one file would race on the same blobs.
 */
export function startRetentionScheduler(deps: RetentionDeps): void {
  stopRetentionScheduler()
  currentDeps = deps
  scheduleNext(deps, TICK_IDLE_MS)
}

export function stopRetentionScheduler(): void {
  currentDeps = null
  clearScheduledTick()
}

/**
 * Run one pass now instead of waiting for the next tick; the schedule continues
 * from it. Returns false when no scheduler runs in this process.
 */
export async function runScheduledRetentionNow(): Promise<boolean> {
  if (inFlight) await inFlight
  const deps = currentDeps
  if (!deps) return false
  clearScheduledTick()
  await runTick(deps)
  return true
}

function clearScheduledTick(): void {
  if (currentTimer) {
    clearTimeout(currentTimer)
    currentTimer = null
  }
}

function scheduleNext(deps: RetentionDeps, delayMs: number): void {
  currentTimer = setTimeout(() => void runTick(deps), delayMs)
  // Housekeeping must never keep a process alive on its own.
  currentTimer.unref()
}

function runTick(deps: RetentionDeps): Promise<void> {
  const run = tick(deps).finally(() => {
    if (inFlight === run) inFlight = null
  })
  inFlight = run
  return run
}

async function tick(deps: RetentionDeps): Promise<void> {
  if (currentDeps !== deps) return
  const now = deps.now ?? Date.now
  const db = deps.getDb()
  const config = deps.getConfig()
  // Deliberately NOT gated on `config.enabled`: that stops new events, while this
  // bounds the disk. Skipping it while disabled kept everything recorded before the
  // user opted out, forever.
  if (!db) {
    scheduleNext(deps, TICK_IDLE_MS)
    return
  }

  let moreWork = false
  try {
    const result = await runRetentionChunk(db, config, now())
    moreWork = result.moreWork
  } catch (err) {
    // Don't recordDiagnosticEvent — same DB would recurse on DB-level failure
    console.error('[diagnostics retention] chunk failed:', err)
  }

  runBlobRetention(config, now(), deps.blobFs)

  if (currentDeps !== deps) return
  scheduleNext(deps, moreWork ? TICK_WORK_MS : TICK_IDLE_MS)
}
