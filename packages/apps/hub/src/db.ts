import Database from 'better-sqlite3'
import path from 'node:path'
import {
  DB_PRAGMAS,
  getDbName,
  getStorageDir,
  type SlayzoneDb,
  type PreparedBridge,
  type BatchOp,
  type RunResult,
  type TxnName,
  type TxnParams,
  type TxnResult
} from '@slayzone/platform'
import { domainTxnRegistry } from '@slayzone/transport/txns'
import {
  bootstrapSchema,
  createPreMigrationBackup,
  LATEST_MIGRATION_VERSION
} from '@slayzone/transport/db-bootstrap'
import { createDiagnosticsSchema, applyDiagnosticsPragmas } from '@slayzone/diagnostics/server'

/**
 * Resolves the SQLite path the side-car should open — DERIVED from the storage
 * dir, identically in every mode. `getStorageDir()` returns `<ROOT>/storage`
 * (from SLAYZONE_ROOT), the SAME dir the Electron host + standalone entrypoint
 * derive; the filename is dev-vs-packaged (`SLAYZONE_DEV`). No file-pointing var
 * exists to thread across the process boundary — supervised and standalone both
 * compute the same path from ROOT, so there is no two-DB-split risk to guard.
 */
export function getDatabasePathFromEnv(): string {
  const name = getDbName(process.env.SLAYZONE_DEV !== '1')
  return path.join(getStorageDir(), name)
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

/**
 * Open the shared DB and bring its schema up to date. THE HUB OWNS THE SCHEMA IN
 * EVERY MODE — there is deliberately no option to skip this.
 *
 * It used to take `{ bootstrapSchema: !supervised }`: a supervised hub opened the
 * Electron host's already-migrated file and was forbidden to touch the schema,
 * because the host's DB worker got there first. That is one file with two writers,
 * one of them told not to touch the schema — and it forced the host to migrate
 * even in REMOTE mode, where it carries a local copy of a schema whose data lives
 * on the server. Removing the parameter makes the special-case unrepresentable
 * rather than merely unused.
 *
 * The pre-migration backup lives HERE, immediately before `bootstrapSchema`, on
 * this same connection — `db.backup()` snapshots the live connection, so the two
 * belong in one function where no future caller can interleave them. It self-skips
 * on a fresh (v0) or already-current store.
 *
 * Async only because of that backup; every query path stays synchronous.
 */
export async function openServerDatabase(): Promise<SlayzoneDb> {
  const db = new Database(getDatabasePathFromEnv())
  for (const pragma of DB_PRAGMAS) db.pragma(pragma)
  // Same derivation as the DB path itself, so the backup can never be named for
  // a different channel than the file it backs up.
  const filePrefix = getDbName(process.env.SLAYZONE_DEV !== '1').replace(/\.sqlite$/, '')
  await createPreMigrationBackup(
    db,
    LATEST_MIGRATION_VERSION,
    path.join(getStorageDir(), 'backups'),
    filePrefix
  )
  bootstrapSchema(db)
  return new SyncSlayzoneDb(db)
}

/**
 * Open the separate diagnostics events DB (`slayzone[.dev].diagnostics.sqlite`,
 * sibling of the main DB). The sidecar owns pty + the agent pool, so its
 * `recordDiagnosticEvent` calls must persist HERE — otherwise they buffer and
 * drop (the events DB was only ever bound in the Electron host, so sidecar
 * diagnostics were invisible). WAL + busy_timeout (DB_PRAGMAS) make the two-process
 * (host + sidecar) writers safe; the schema is now literally shared rather than
 * "mirrored", which is what let the two drift.
 */
export function openServerDiagnosticsDatabase(): SlayzoneDb {
  const diagPath = getDatabasePathFromEnv().replace(/\.sqlite$/, '.diagnostics.sqlite')
  const db = new Database(diagPath)
  // ONE schema definition, shared with the Electron host's diag worker
  // (diagnostics/server/schema.ts). These used to diverge — four indexes and
  // auto_vacuum on the host side, two indexes and none here — and since both
  // processes open this same file, whichever created it first silently decided
  // the other's schema. auto_vacuum in particular cannot be set afterwards.
  //
  // Repair (`selfHealDiagnosticsDb`) is deliberately NOT run here: rotating a file
  // the host may hold open is the hazard, so the host owns repair and starts first.
  applyDiagnosticsPragmas(db)
  for (const pragma of DB_PRAGMAS) db.pragma(pragma)
  createDiagnosticsSchema(db)
  return new SyncSlayzoneDb(db)
}
