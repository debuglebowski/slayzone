import Database from 'better-sqlite3'
import path from 'node:path'
import {
  DB_PRAGMAS,
  getDbName,
  getStateDir,
  type SlayzoneDb,
  type PreparedBridge,
  type BatchOp,
  type RunResult,
  type TxnName,
  type TxnParams,
  type TxnResult
} from '@slayzone/platform'
import { domainTxnRegistry } from '@slayzone/transport/txns'
import { bootstrapSchema } from '@slayzone/transport/db-bootstrap'

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
 * expects, without a worker. `namedTxn` dispatches against the shared domain
 * registry (`@slayzone/transport/txns`); app-only txns are absent by design.
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

  async namedTxn<K extends TxnName>(name: K, params: TxnParams<K>): Promise<Awaited<TxnResult<K>>> {
    // Domain txns only — the two app-only sources (export-import, reset-for-test)
    // have all their call sites inside apps/app and are deliberately absent here.
    const fn = (domainTxnRegistry as Record<string, (db: Database.Database, p: unknown) => unknown>)[
      name as string
    ]
    if (!fn) {
      throw new Error(
        `Unknown named transaction "${String(name)}" — not registered in the standalone server (app-only txns live in apps/app)`
      )
    }
    return (await fn(this.db, params)) as Awaited<TxnResult<K>>
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

export function openServerDatabase(opts?: { bootstrapSchema?: boolean }): SlayzoneDb {
  const db = new Database(getDatabasePathFromEnv())
  for (const pragma of DB_PRAGMAS) db.pragma(pragma)
  // Standalone boots own their schema (the Electron host's DB worker does the
  // equivalent on its side, plus legacy-path migration + pre-migration backup).
  if (opts?.bootstrapSchema) bootstrapSchema(db)
  return new SyncSlayzoneDb(db)
}

/**
 * Open the separate diagnostics events DB (`slayzone[.dev].diagnostics.sqlite`,
 * sibling of the main DB). The sidecar owns pty + the agent pool, so its
 * `recordDiagnosticEvent` calls must persist HERE — otherwise they buffer and
 * drop (the events DB was only ever bound in the Electron host, so sidecar
 * diagnostics were invisible). Schema mirrors the host's diag worker and is
 * created idempotently: a no-op in supervised mode (the host already made it),
 * a bootstrap standalone. WAL + busy_timeout (DB_PRAGMAS) make the two-process
 * (host + sidecar) writers safe.
 */
export function openServerDiagnosticsDatabase(): SlayzoneDb {
  const diagPath = getDatabasePathFromEnv().replace(/\.sqlite$/, '.diagnostics.sqlite')
  const db = new Database(diagPath)
  for (const pragma of DB_PRAGMAS) db.pragma(pragma)
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
    CREATE INDEX IF NOT EXISTS idx_diag_source_event_ts ON diagnostics_events(source, event, ts_ms);
  `)
  return new SyncSlayzoneDb(db)
}
