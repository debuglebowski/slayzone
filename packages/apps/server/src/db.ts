import Database from 'better-sqlite3'
import path from 'node:path'
import {
  DB_PRAGMAS,
  getDbName,
  getStateDir,
  type SlayzoneDb,
  type PreparedBridge,
  type BatchOp,
  type RunResult
} from '@slayzone/platform'

/**
 * Resolves the SQLite path the side-car should open.
 *
 * Supervised (`SLAYZONE_SUPERVISED=1`): the Electron host already resolved its
 * DB path once and passes that exact absolute string as `SLAYZONE_DB_PATH`.
 * We open it verbatim — no dir/name/dev recombination. If it is missing we
 * hard-error rather than guess: divergence becomes a loud crash, never a
 * silent two-DB split.
 *
 * Standalone: resolve from dir + name like the CLI does.
 */
export function getDatabasePathFromEnv(): string {
  if (process.env.SLAYZONE_SUPERVISED === '1') {
    const p = process.env.SLAYZONE_DB_PATH
    if (!p) {
      throw new Error(
        '[slayzone-server] supervised but SLAYZONE_DB_PATH unset — refusing to guess a DB path'
      )
    }
    return p
  }
  if (process.env.SLAYZONE_DB_PATH) return process.env.SLAYZONE_DB_PATH
  const dir = process.env.SLAYZONE_STORE_DIR ?? process.env.SLAYZONE_DB_DIR ?? getStateDir()
  const name = process.env.SLAYZONE_DB_NAME ?? getDbName(process.env.SLAYZONE_DEV !== '1')
  return path.join(dir, name)
}

/**
 * Synchronous in-process implementation of the async `SlayzoneDb` interface.
 *
 * In the Electron app the connection lives in a worker thread so queries don't
 * block the UI thread. The standalone side-car has no UI thread to protect, so
 * it runs better-sqlite3 directly and wraps each call in a resolved promise —
 * satisfying the one `SlayzoneDb` contract every domain/router consumer now
 * expects, without a worker. `namedTxn` is unsupported here (the named-txn
 * registry is app-side); the tRPC router the side-car serves does not use it.
 */
class SyncSlayzoneDb implements SlayzoneDb {
  constructor(private readonly db: Database.Database) {}

  async get<T = unknown>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return this.db.prepare(sql).get(...params) as T | undefined
  }

  async all<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...params) as T[]
  }

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    const r = this.db.prepare(sql).run(...params)
    return { changes: r.changes, lastInsertRowid: r.lastInsertRowid }
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql)
  }

  async batchTxn(ops: BatchOp[]): Promise<unknown[]> {
    return this.db.transaction(() => ops.map((op) => this.db.prepare(op.sql)[op.type](...op.params)))()
  }

  async namedTxn<T = unknown>(): Promise<T> {
    throw new Error('namedTxn is not supported in the standalone server')
  }

  async backup(destPath: string): Promise<void> {
    await this.db.backup(destPath)
  }

  prepare(sql: string): PreparedBridge {
    const stmt = this.db.prepare(sql)
    return {
      get: async <T = unknown>(...params: unknown[]) => stmt.get(...params) as T | undefined,
      all: async <T = unknown>(...params: unknown[]) => stmt.all(...params) as T[],
      run: async (...params: unknown[]) => {
        const r = stmt.run(...params)
        return { changes: r.changes, lastInsertRowid: r.lastInsertRowid }
      }
    }
  }

  async close(): Promise<void> {
    this.db.close()
  }
}

export function openServerDatabase(): SlayzoneDb {
  const db = new Database(getDatabasePathFromEnv())
  for (const pragma of DB_PRAGMAS) db.pragma(pragma)
  return new SyncSlayzoneDb(db)
}
