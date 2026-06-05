import type { TxnName, TxnParams, TxnResult } from './txn-registry-map'

/** SQLite PRAGMAs required for all connections to the SlayZone database. */
export const DB_PRAGMAS = [
  'journal_mode = WAL',
  'foreign_keys = ON',
  'synchronous = NORMAL',
  'cache_size = -8000',
  'busy_timeout = 5000'
] as const

/** A single statement in a `batchTxn` op list. */
export type BatchOp = {
  type: 'get' | 'all' | 'run'
  sql: string
  params: unknown[]
}

/** Mirrors better-sqlite3's `RunResult`. `lastInsertRowid` may be a bigint. */
export type RunResult = {
  changes: number
  lastInsertRowid: number | bigint
}

/**
 * A prepared-statement handle. Mirrors the subset of better-sqlite3's
 * `Statement` the codebase uses (`get`/`all`/`run`), but every call is async
 * because execution happens in the SQLite worker thread. Params are spread to
 * match better-sqlite3 (`stmt.get(a, b)` or `stmt.get({ named }))`.
 */
export interface PreparedBridge {
  get<T = unknown>(...params: unknown[]): Promise<T | undefined>
  all<T = unknown>(...params: unknown[]): Promise<T[]>
  run(...params: unknown[]): Promise<RunResult>
}

/**
 * The SlayZone DB handle. The connection lives in a worker thread; this is the
 * async proxy every main-process module receives. Engine choice lives here in
 * one place — a future swap redefines this rather than every consumer.
 *
 * Deliberately has NO synchronous `transaction()`: transactions must go through
 * `batchTxn` (a static op list) or `namedTxn` (pre-registered conditional
 * read-modify-write logic) so they run atomically inside the worker and never
 * split across the thread boundary.
 */
export interface SlayzoneDb {
  get<T = unknown>(sql: string, params?: unknown[]): Promise<T | undefined>
  all<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>
  run(sql: string, params?: unknown[]): Promise<RunResult>
  exec(sql: string): Promise<void>
  batchTxn(ops: BatchOp[]): Promise<unknown[]>
  /**
   * Invoke a pre-registered named transaction. `name` is keyed off the
   * `TxnRegistry` map (augmented by each domain), so the params shape and the
   * resolved result type are inferred from the registered impl — no generic to
   * pass, no `as` casts. Unknown names are a compile error.
   */
  namedTxn<K extends TxnName>(name: K, params: TxnParams<K>): Promise<Awaited<TxnResult<K>>>
  /** Online backup of the live connection to `destPath` (manual/restore backups). */
  backup(destPath: string): Promise<void>
  prepare(sql: string): PreparedBridge
  close(): Promise<void>
}

/**
 * The DB filename for a given build. `packaged` Electron uses the production
 * file; everything else uses the dev file. Single source of truth so the
 * Electron host and a standalone side-car never disagree on which file to open.
 */
export function getDbName(packaged: boolean): string {
  return packaged ? 'slayzone.sqlite' : 'slayzone.dev.sqlite'
}
