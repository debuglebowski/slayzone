import { join } from 'node:path'
import type {
  SlayzoneDb,
  PreparedBridge,
  BatchOp,
  RunResult,
  TxnName,
  TxnParams,
  TxnResult
} from '@slayzone/platform'
import { WorkerRpcClient } from './worker-rpc-client'
import type { DiagWorkerData } from './worker-protocol'

/**
 * Async proxy to the DIAGNOSTICS SQLite worker — the only database this process
 * still opens.
 *
 * `WorkerDbBridge` used to live in `db-bridge.ts` and back both workers. That
 * file is gone with the shared-DB worker, so the class moved here, to its one
 * remaining consumer. It keeps the full `SlayzoneDb` surface because that is the
 * interface `bindDiagnosticsDbs` expects; `namedTxn` is unused and rejected
 * worker-side.
 */
export type DiagBridge = SlayzoneDb

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

  namedTxn<K extends TxnName>(name: K, params: TxnParams<K>): Promise<Awaited<TxnResult<K>>> {
    return this.rpc.send<Awaited<TxnResult<K>>>({ type: 'named-txn', name, params })
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

export async function createDiagBridge(data: DiagWorkerData): Promise<DiagBridge> {
  const workerPath = join(__dirname, 'diag-worker.js')
  const rpc = new WorkerRpcClient(workerPath, data)
  await rpc.ready
  return new WorkerDbBridge(rpc)
}
