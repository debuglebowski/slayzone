/**
 * RPC protocol shared between the Electron main thread and the SQLite worker
 * thread. The worker owns the only `better-sqlite3` connection; main talks to
 * it exclusively through these messages over `parentPort`/`Worker.postMessage`.
 *
 * Every request carries a unique `id` so the bridge can correlate the matching
 * response. Transactions never cross the boundary: `batch-txn` ships a static
 * op list executed atomically inside the worker, and `named-txn` invokes a
 * pre-registered function (for conditional read-modify-write logic).
 */

import type { BatchOp, RunResult } from '@slayzone/platform'

export type { BatchOp, RunResult }

export type WorkerRequest =
  | { id: string; type: 'get'; sql: string; params: unknown[] }
  | { id: string; type: 'all'; sql: string; params: unknown[] }
  | { id: string; type: 'run'; sql: string; params: unknown[] }
  | { id: string; type: 'exec'; sql: string }
  | { id: string; type: 'batch-txn'; ops: BatchOp[] }
  | { id: string; type: 'named-txn'; name: string; params: unknown }
  // Online backup of the live connection (manual/restore backups). Async —
  // only the worker holds the connection `db.backup()` snapshots.
  | { id: string; type: 'backup'; destPath: string }

export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'init-error'; error: string }
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string }

/**
 * Bootstrap data passed to the worker via `workerData`. ALL Electron-dependent
 * path/flag resolution happens on the main thread and is handed over here — the
 * worker never imports `electron`.
 */
export type DbWorkerData = {
  dbPath: string
  backupsDir: string
  backupFilePrefix: string
  targetVersion: number
  legacy: LegacyMigrationPaths | null
}

export type LegacyMigrationPaths = {
  oldUserData: string
  newUserData: string
}

export type DiagWorkerData = {
  dbPath: string
}
