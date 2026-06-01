import { join } from 'node:path'
import type { SlayzoneDb, PreparedBridge, BatchOp, RunResult } from '@slayzone/platform'
import { WorkerRpcClient } from './worker-rpc-client'
import type { DbWorkerData } from './worker-protocol'

/**
 * Async proxy to the SQLite worker. This is the concrete `SlayzoneDb` handle
 * every domain module receives; the interface itself lives in `@slayzone/platform`
 * so the engine choice has one home. Transactions go through `batchTxn` /
 * `namedTxn` (never a sync `transaction()`) so they run atomically inside the
 * worker.
 */
export type DbBridge = SlayzoneDb

export class WorkerDbBridge implements SlayzoneDb {
  constructor(private readonly rpc: WorkerRpcClient) {}

  get<T = unknown>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return this.rpc.send<T | undefined>({ type: 'get', sql, params })
  }

  all<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.rpc.send<T[]>({ type: 'all', sql, params })
  }

  run(sql: string, params: unknown[] = []): Promise<RunResult> {
    return this.rpc.send<RunResult>({ type: 'run', sql, params })
  }

  exec(sql: string): Promise<void> {
    return this.rpc.send<void>({ type: 'exec', sql })
  }

  batchTxn(ops: BatchOp[]): Promise<unknown[]> {
    return this.rpc.send<unknown[]>({ type: 'batch-txn', ops })
  }

  namedTxn<T = unknown>(name: string, params: unknown): Promise<T> {
    return this.rpc.send<T>({ type: 'named-txn', name, params })
  }

  backup(destPath: string): Promise<void> {
    return this.rpc.send<void>({ type: 'backup', destPath })
  }

  prepare(sql: string): PreparedBridge {
    const rpc = this.rpc
    return {
      get: <T = unknown>(...params: unknown[]) =>
        rpc.send<T | undefined>({ type: 'get', sql, params }),
      all: <T = unknown>(...params: unknown[]) => rpc.send<T[]>({ type: 'all', sql, params }),
      run: (...params: unknown[]) => rpc.send<RunResult>({ type: 'run', sql, params })
    }
  }

  close(): Promise<void> {
    return this.rpc.close()
  }
}

/**
 * Spawn the DB worker and resolve once it has finished its startup sequence
 * (migrations + normalizations all run inside the worker before `ready`).
 */
export async function createDbBridge(data: DbWorkerData): Promise<DbBridge> {
  const workerPath = join(__dirname, 'db-worker.js')
  const rpc = new WorkerRpcClient(workerPath, data)
  await rpc.ready
  return new WorkerDbBridge(rpc)
}
