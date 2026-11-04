/**
 * Worker-thread entry for the hub's DATA database (`slayzone[.dev].data.sqlite`),
 * bundled as `dist/db-worker.cjs` beside `bin.cjs`. `openServerDatabase()` (db.ts)
 * spawns it; it owns the one connection to that file.
 *
 * Startup runs here, before `ready`: adopt a pre-rename file → open → pragmas →
 * pre-migration backup (needs this live connection) → schema bootstrap. So no
 * query can race migrations, and a long migration never freezes the hub's thread.
 *
 * Imports only worker-safe entries: the domain txn registry (`@slayzone/api/txns`,
 * each domain's electron-free `./db`) and the schema boot. Nothing here may pull
 * electron, node-pty or a React barrel.
 */
import Database from 'better-sqlite3'
import { DB_PRAGMAS, adoptRenamedDatabase } from '@slayzone/platform'
import { serveSqliteWorker } from '@slayzone/platform/sqlite-worker-host'
import { domainTxnRegistry } from '@slayzone/api/txns'
import { createPreMigrationBackup, LATEST_MIGRATION_VERSION } from '@slayzone/db-migrations'
import { bootstrapSchema } from './bootstrap-schema'
import type { HubDataDbWorkerData } from './db'

serveSqliteWorker<HubDataDbWorkerData>({
  label: 'the hub data DB worker',
  // Domain txns only — the app has no registry of its own any more; export/import
  // and reset-for-test are part of the domain registry.
  txns: domainTxnRegistry,
  open: async (data) => {
    // The main DB was renamed `slayzone.sqlite` → `slayzone.data.sqlite`. A hub root a
    // beta wrote (and every standalone hub) still holds the old name; move it BEFORE
    // opening, or `new Database()` would create a fresh empty file beside the real one.
    // A no-op once done.
    adoptRenamedDatabase(data.storageDir, data.legacyDbName, data.dbName)
    const db = new Database(data.dbPath)
    try {
      for (const pragma of DB_PRAGMAS) db.pragma(pragma)
      // `db.backup()` snapshots THIS connection, so the backup and the bootstrap stay
      // together on it. Self-skips on a fresh (v0) or already-current store.
      await createPreMigrationBackup(
        db,
        LATEST_MIGRATION_VERSION,
        data.backupsDir,
        data.backupFilePrefix
      )
      bootstrapSchema(db)
    } catch (err) {
      db.close()
      throw err
    }
    return db
  }
})
