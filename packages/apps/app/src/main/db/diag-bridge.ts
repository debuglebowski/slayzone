import { join } from 'node:path'
import { WorkerRpcClient } from './worker-rpc-client'
import { WorkerDbBridge, type DbBridge } from './db-bridge'
import type { DiagWorkerData } from './worker-protocol'

/**
 * Async proxy to the diagnostics SQLite worker. Same surface as `DbBridge`
 * (the diagnostics service uses get/all/run/exec/batchTxn) — `namedTxn` is
 * unused and rejected worker-side. Reuses the same RPC client and bridge class
 * as the main DB; only the worker entry and `workerData` differ.
 */
export type DiagBridge = DbBridge

export async function createDiagBridge(data: DiagWorkerData): Promise<DiagBridge> {
  const workerPath = join(__dirname, 'diag-worker.js')
  const rpc = new WorkerRpcClient(workerPath, data)
  await rpc.ready
  return new WorkerDbBridge(rpc)
}
