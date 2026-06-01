import { app } from 'electron'
import path from 'path'
import { getDbName } from '@slayzone/platform'
import { LATEST_MIGRATION_VERSION } from './migrations'
import { createDbBridge, type DbBridge } from './db-bridge'
import { createDiagBridge, type DiagBridge } from './diag-bridge'
import type { LegacyMigrationPaths } from './worker-protocol'

const LEGACY_APP_NAME = 'omgslayzone'

export const getDatabasePath = (): string => {
  const userDataPath = process.env.SLAYZONE_DB_DIR || app.getPath('userData')
  return path.join(userDataPath, getDbName(app.isPackaged))
}

const getDiagnosticsDatabasePath = (): string => {
  const userDataPath = process.env.SLAYZONE_DB_DIR || app.getPath('userData')
  const dbName = app.isPackaged ? 'slayzone.diagnostics.sqlite' : 'slayzone.dev.diagnostics.sqlite'
  return path.join(userDataPath, dbName)
}

const getBackupsDir = (): string => {
  const userDataPath = process.env.SLAYZONE_DB_DIR || app.getPath('userData')
  return path.join(userDataPath, 'backups')
}

// Resolve the legacy `omgslayzone` → `slayzone` migration paths on the main
// thread (Electron `app.getPath`) so the worker can run the file copy without
// importing electron.
const resolveLegacyPaths = (): LegacyMigrationPaths => ({
  oldUserData: path.join(app.getPath('appData'), LEGACY_APP_NAME),
  newUserData: app.getPath('userData')
})

// The connection lives in the worker; these module-level handles are the
// main-thread async proxies, assigned once by `initDatabases` at boot. Kept as
// a singleton so the legacy synchronous `getDatabase()` accessor pattern
// survives — call sites just await the (now async) query methods.
let db: DbBridge | null = null
let diagDb: DiagBridge | null = null

/**
 * Spawn both SQLite workers and wait for each to finish its startup sequence
 * (the main DB worker runs legacy migration, pragmas, pre-migration backup,
 * schema migrations, and normalizations before signalling ready). All
 * Electron-dependent paths are resolved here and passed via workerData.
 */
export async function initDatabases(): Promise<{ db: DbBridge; diagDb: DiagBridge }> {
  const [mainBridge, diagBridge] = await Promise.all([
    createDbBridge({
      dbPath: getDatabasePath(),
      backupsDir: getBackupsDir(),
      backupFilePrefix: app.isPackaged ? 'slayzone' : 'slayzone.dev',
      targetVersion: LATEST_MIGRATION_VERSION,
      legacy: resolveLegacyPaths()
    }),
    createDiagBridge({ dbPath: getDiagnosticsDatabasePath() })
  ])
  db = mainBridge
  diagDb = diagBridge
  return { db, diagDb }
}

/** Synchronous accessor for the already-initialized main DB bridge. */
export function getDatabase(): DbBridge {
  if (!db) throw new Error('getDatabase() called before initDatabases()')
  return db
}

/** Synchronous accessor for the already-initialized diagnostics DB bridge. */
export function getDiagnosticsDatabase(): DiagBridge {
  if (!diagDb) throw new Error('getDiagnosticsDatabase() called before initDatabases()')
  return diagDb
}

export async function closeDatabase(): Promise<void> {
  if (db) {
    await db.close()
    db = null
  }
}

export async function closeDiagnosticsDatabase(): Promise<void> {
  if (diagDb) {
    await diagDb.close()
    diagDb = null
  }
}
