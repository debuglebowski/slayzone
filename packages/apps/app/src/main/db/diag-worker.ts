import { parentPort, workerData } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { selfHealDiagnosticsDb, scheduleSalvageMergeForAll } from '@slayzone/diagnostics/self-heal'
import type { BatchOp, DiagWorkerData, WorkerRequest, WorkerResponse } from './worker-protocol'

/**
 * Diagnostics SQLite worker. Owns the connection to the separate diagnostics DB
 * (`slayzone[.dev].diagnostics.sqlite`).
 *
 * Kept in its own worker — not folded into the main DB worker — to preserve the
 * isolation the v41 migration established: diagnostics writes must never share a
 * transaction queue or connection with task/settings data, which is what
 * prevents the CLI-notify → tasks:changed → diagnostic-write → notify loop.
 *
 * Startup is fully synchronous (self-heal rotate → open → pragmas → schema →
 * schedule background salvage merge), so no async IIFE is needed. Imports only
 * the pure `@slayzone/diagnostics/self-heal` entry — never the `/main` barrel,
 * which pulls Electron via the diagnostics service.
 */

const port = parentPort
if (!port) throw new Error('diag-worker must run as a worker thread')

const data = workerData as DiagWorkerData

let db: Database.Database
try {
  selfHealDiagnosticsDb(data.dbPath)
  db = new Database(data.dbPath)
  // auto_vacuum MUST be set before any table exists. No-op for pre-existing DBs.
  db.pragma('auto_vacuum = INCREMENTAL')
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS diagnostics_events (
      id TEXT PRIMARY KEY,
      ts_ms INTEGER NOT NULL,
      level TEXT NOT NULL,
      source TEXT NOT NULL,
      event TEXT NOT NULL,
      trace_id TEXT,
      task_id TEXT,
      project_id TEXT,
      session_id TEXT,
      channel TEXT,
      message TEXT,
      payload_json TEXT,
      redaction_version INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_diag_ts ON diagnostics_events(ts_ms);
    CREATE INDEX IF NOT EXISTS idx_diag_level_ts ON diagnostics_events(level, ts_ms);
    CREATE INDEX IF NOT EXISTS idx_diag_trace ON diagnostics_events(trace_id);
    CREATE INDEX IF NOT EXISTS idx_diag_source_event_ts ON diagnostics_events(source, event, ts_ms);
  `)
  scheduleSalvageMergeForAll(() => db, data.dbPath)
} catch (err) {
  port.postMessage({
    type: 'init-error',
    error: err instanceof Error ? err.message : String(err)
  } satisfies WorkerResponse)
  throw err
}

const stmtCache = new Map<string, Database.Statement>()
function stmt(sql: string): Database.Statement {
  let s = stmtCache.get(sql)
  if (!s) {
    s = db.prepare(sql)
    stmtCache.set(sql, s)
  }
  return s
}

function handle(req: WorkerRequest): unknown {
  switch (req.type) {
    case 'get':
      return stmt(req.sql).get(...req.params)
    case 'all':
      return stmt(req.sql).all(...req.params)
    case 'run':
      return stmt(req.sql).run(...req.params)
    case 'exec':
      db.exec(req.sql)
      return undefined
    case 'batch-txn':
      return db.transaction(() =>
        req.ops.map((op: BatchOp) => stmt(op.sql)[op.type](...op.params))
      )()
    case 'named-txn':
      throw new Error('diag-worker does not support named transactions')
    case 'backup':
      return db.backup(req.destPath)
  }
}

port.on('message', (req: WorkerRequest) => {
  try {
    const result = handle(req)
    port.postMessage({ id: req.id, ok: true, result } satisfies WorkerResponse)
  } catch (err) {
    port.postMessage({
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    } satisfies WorkerResponse)
  }
})

port.postMessage({ type: 'ready' } satisfies WorkerResponse)
