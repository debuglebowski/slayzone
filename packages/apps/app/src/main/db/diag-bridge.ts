import { join } from 'node:path'
import type { SlayzoneDb } from '@slayzone/platform'
import { openSqliteWorker } from '@slayzone/platform/sqlite-worker'

/**
 * Async proxy to the DIAGNOSTICS SQLite worker — the only database this process
 * still opens. The RPC (request/response, error codes, Buffers, close) is the
 * shared `@slayzone/platform/sqlite-worker`, the same one the hub's DBs use. It
 * keeps the full `SlayzoneDb` surface because that is the interface
 * `bindDiagnosticsDbs` expects; `namedTxn` rejects (the worker registers none).
 */
export type DiagBridge = SlayzoneDb

/**
 * Bootstrap data for `diag-worker.ts`. ALL Electron-dependent path resolution
 * happens on the main thread — the worker never imports `electron`.
 */
export type DiagWorkerData = {
  dbPath: string
}

export function createDiagBridge(data: DiagWorkerData): Promise<DiagBridge> {
  return openSqliteWorker({
    label: 'the desktop diagnostics DB worker',
    workerPath: join(__dirname, 'diag-worker.js'),
    workerData: data
  })
}
