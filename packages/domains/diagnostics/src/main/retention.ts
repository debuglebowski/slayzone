import type { Database } from 'better-sqlite3'
import type { DiagnosticsConfig } from '../shared'

const HARD_EVENT_CAP = 200_000
const CHUNK_LIMIT = 1000
const TICK_IDLE_MS = 60_000
const TICK_WORK_MS = 3_000

export interface RetentionDeps {
  getDb: () => Database | null
  getConfig: () => DiagnosticsConfig
  now?: () => number
}

export function runRetentionChunk(
  db: Database,
  config: DiagnosticsConfig,
  nowMs: number = Date.now()
): { deleted: number; moreWork: boolean } {
  const { count } = db
    .prepare('SELECT COUNT(*) as count FROM diagnostics_events')
    .get() as { count: number }

  if (count > HARD_EVENT_CAP) {
    const limit = Math.min(count - HARD_EVENT_CAP, CHUNK_LIMIT)
    const res = db
      .prepare(`
        DELETE FROM diagnostics_events
        WHERE id IN (SELECT id FROM diagnostics_events ORDER BY ts_ms ASC LIMIT ?)
      `)
      .run(limit)
    const deleted = Number(res.changes)
    return { deleted, moreWork: count - deleted > HARD_EVENT_CAP || deleted === CHUNK_LIMIT }
  }

  const cutoff = nowMs - config.retentionDays * 24 * 60 * 60 * 1000
  const res = db
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
  return { deleted, moreWork: deleted === CHUNK_LIMIT }
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
  currentTimer = setTimeout(() => tick(deps), delayMs)
}

function tick(deps: RetentionDeps): void {
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
    const result = runRetentionChunk(db, config, now())
    moreWork = result.moreWork
  } catch (err) {
    // Don't recordDiagnosticEvent — same DB would recurse on DB-level failure
    console.error('[diagnostics retention] chunk failed:', err)
  }
  scheduleNext(deps, moreWork ? TICK_WORK_MS : TICK_IDLE_MS)
}
