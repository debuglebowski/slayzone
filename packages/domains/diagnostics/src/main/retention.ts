import type { SlayzoneDb } from '@slayzone/platform'
import type { DiagnosticsConfig } from '../shared'

const HARD_EVENT_CAP = 200_000
const CHUNK_LIMIT = 10_000
const TICK_IDLE_MS = 60_000
const TICK_WORK_MS = 3_000

export interface RetentionDeps {
  getDb: () => SlayzoneDb | null
  getConfig: () => DiagnosticsConfig
  now?: () => number
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
let isStopped = false

export function startRetentionScheduler(deps: RetentionDeps): void {
  stopRetentionScheduler()
  isStopped = false
  scheduleNext(deps, TICK_IDLE_MS)
}

export function stopRetentionScheduler(): void {
  isStopped = true
  if (currentTimer) {
    clearTimeout(currentTimer)
    currentTimer = null
  }
}

function scheduleNext(deps: RetentionDeps, delayMs: number): void {
  currentTimer = setTimeout(() => void tick(deps), delayMs)
}

async function tick(deps: RetentionDeps): Promise<void> {
  if (isStopped) return
  const now = deps.now ?? Date.now
  const db = deps.getDb()
  const config = deps.getConfig()
  if (!db || !config.enabled) {
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
  if (isStopped) return
  scheduleNext(deps, moreWork ? TICK_WORK_MS : TICK_IDLE_MS)
}
