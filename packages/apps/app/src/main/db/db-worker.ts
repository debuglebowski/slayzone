import { parentPort, workerData } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { DB_PRAGMAS } from '@slayzone/platform'
import { syncTerminalModes } from '@slayzone/terminal/db'
import { migrateLegacyDatabaseIfNeeded } from './legacy-migration'
import { createPreMigrationBackup } from './pre-migration-backup'
import { runMigrations } from './migrations'
import { normalizeProjectStatusData } from './status-normalization'
import { txnRegistry } from './txn-registry'
import type { DbWorkerData, WorkerRequest, WorkerResponse } from './worker-protocol'

/**
 * The SQLite worker thread. Owns the ONLY `better-sqlite3` connection to the
 * main database. The main thread reaches it exclusively through the RPC
 * protocol in `worker-protocol.ts`.
 *
 * Startup is Option A: this worker runs the entire DB bring-up sequence —
 * legacy file migration → open + pragmas → pre-migration backup (needs the live
 * connection) → schema migrations v1..vN → data normalizations → terminal-mode
 * sync — and only then posts `ready`. The main thread's `createDbBridge` awaits
 * that signal, so no query can race ahead of migrations.
 *
 * No `electron` import: every path/flag is resolved on the main thread and
 * arrives via `workerData`. Startup runs in an async IIFE because the Electron
 * main bundle is CJS (no top-level await) and `db.backup()` is async.
 */

const port = parentPort
if (!port) throw new Error('db-worker must run as a worker thread')

const data = workerData as DbWorkerData

// Module-level handle, assigned during init before the message loop is wired.
let db: Database.Database

// Prepared-statement cache, keyed by SQL string. Reusing compiled statements is
// what keeps per-call cost near native — re-preparing on every RPC would erase
// the win of moving off the main thread.
const stmtCache = new Map<string, Database.Statement>()
function stmt(sql: string): Database.Statement {
  let s = stmtCache.get(sql)
  if (!s) {
    s = db.prepare(sql)
    stmtCache.set(sql, s)
  }
  return s
}

function handle(req: WorkerRequest): unknown | Promise<unknown> {
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
      return db.transaction(() => req.ops.map((op) => stmt(op.sql)[op.type](...op.params)))()
    case 'named-txn': {
      const fn = txnRegistry[req.name]
      if (!fn) throw new Error(`Unknown named transaction: ${req.name}`)
      // The registered fn owns its own db.transaction(...) — do not re-wrap
      // (better-sqlite3 forbids nested BEGIN).
      return fn(db, req.params as never)
    }
    case 'backup':
      return db.backup(req.destPath)
  }
}

void (async () => {
  try {
    migrateLegacyDatabaseIfNeeded(data.legacy)
    db = new Database(data.dbPath)
    for (const pragma of DB_PRAGMAS) db.pragma(pragma)
    await createPreMigrationBackup(db, data.targetVersion, data.backupsDir, data.backupFilePrefix)
    runMigrations(db)
    normalizeProjectStatusData(db)
    syncTerminalModes(db)
  } catch (err) {
    port.postMessage({
      type: 'init-error',
      error: err instanceof Error ? err.message : String(err)
    } satisfies WorkerResponse)
    return
  }

  port.on('message', (req: WorkerRequest) => {
    Promise.resolve()
      .then(() => handle(req))
      .then((result) => {
        port.postMessage({ id: req.id, ok: true, result } satisfies WorkerResponse)
      })
      .catch((err: unknown) => {
        port.postMessage({
          id: req.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        } satisfies WorkerResponse)
      })
  })

  port.postMessage({ type: 'ready' } satisfies WorkerResponse)
})()
