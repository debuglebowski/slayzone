import { app } from 'electron'
import Database from 'better-sqlite3'
import { DB_PRAGMAS } from '@slayzone/platform'
import fs from 'fs'
import path from 'path'

const LEGACY_APP_NAME = 'omgslayzone'
const LEGACY_DB_NAMES = ['omgslayzone.sqlite', 'omgslayzone.dev.sqlite'] as const
const DB_SUFFIXES = ['', '-wal', '-shm'] as const

export const getDatabasePath = (): string => {
  const userDataPath = process.env.SLAYZONE_DB_DIR || app.getPath('userData')
  const dbName = app.isPackaged ? 'slayzone.sqlite' : 'slayzone.dev.sqlite'
  return path.join(userDataPath, dbName)
}

let db: Database.Database | null = null
let diagDb: Database.Database | null = null

const getDiagnosticsDatabasePath = (): string => {
  const userDataPath = process.env.SLAYZONE_DB_DIR || app.getPath('userData')
  const dbName = app.isPackaged ? 'slayzone.diagnostics.sqlite' : 'slayzone.dev.diagnostics.sqlite'
  return path.join(userDataPath, dbName)
}

export function getDiagnosticsDatabase(): Database.Database {
  if (!diagDb) {
    const dbPath = getDiagnosticsDatabasePath()
    diagDb = new Database(dbPath)
    diagDb.pragma('journal_mode = WAL')
    diagDb.exec(`
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
      CREATE INDEX IF NOT EXISTS idx_diag_level_ts ON diagnostics_events(level, ts_ms);
      CREATE INDEX IF NOT EXISTS idx_diag_trace ON diagnostics_events(trace_id);
      CREATE INDEX IF NOT EXISTS idx_diag_source_event_ts ON diagnostics_events(source, event, ts_ms);
    `)
  }
  return diagDb
}

export function closeDiagnosticsDatabase(): void {
  if (diagDb) {
    diagDb.close()
    diagDb = null
  }
}

export function migrateLegacyDatabaseIfNeeded(): void {
  const oldUserData = path.join(app.getPath('appData'), LEGACY_APP_NAME)
  const newUserData = app.getPath('userData')

  if (!fs.existsSync(oldUserData)) return

  const migrations = [
    { oldBase: LEGACY_DB_NAMES[0], newBase: 'slayzone.sqlite' },
    { oldBase: LEGACY_DB_NAMES[1], newBase: 'slayzone.dev.sqlite' }
  ]

  let backupDir: string | null = null

  for (const { oldBase, newBase } of migrations) {
    const oldBasePath = path.join(oldUserData, oldBase)
    const newBasePath = path.join(newUserData, newBase)

    if (!fs.existsSync(oldBasePath) || fs.existsSync(newBasePath)) {
      continue
    }

    fs.mkdirSync(newUserData, { recursive: true })

    if (!backupDir) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      backupDir = path.join(oldUserData, `backup-${timestamp}`)
      fs.mkdirSync(backupDir, { recursive: true })
    }

    for (const suffix of DB_SUFFIXES) {
      const oldPath = `${oldBasePath}${suffix}`
      if (!fs.existsSync(oldPath)) continue

      const backupPath = path.join(backupDir, `${oldBase}${suffix}`)
      fs.copyFileSync(oldPath, backupPath)

      const newPath = path.join(newUserData, `${newBase}${suffix}`)
      fs.copyFileSync(oldPath, newPath)
    }
  }
}

export function getDatabase(): Database.Database {
  if (!db) {
    migrateLegacyDatabaseIfNeeded()
    const dbPath = getDatabasePath()
    db = new Database(dbPath)
    for (const pragma of DB_PRAGMAS) {
      db.pragma(pragma)
    }
    // Migrations moved to index.ts for pre-migration backup orchestration
  }
  return db
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}
