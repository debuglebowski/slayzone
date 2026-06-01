import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'

/**
 * Pre-migration backup, runnable inside the DB worker.
 *
 * Lives apart from `main/backup.ts` (which imports `electron` for restore /
 * relaunch / manual-backup IPC) so it stays pure — fs + path + better-sqlite3
 * only. It MUST run inside the worker because `db.backup()` snapshots the live
 * connection, and the worker is the only holder of that connection. The
 * Electron-dependent values (`backupsDir`, `filePrefix`) are resolved on the
 * main thread and handed over via `workerData`.
 *
 * Filename format mirrors backup.ts: `<prefix>.<iso-with-dashes>.migration.sqlite`.
 */
const MIGRATION_BACKUP_REGEX = /\.migration\.sqlite$/

export async function createPreMigrationBackup(
  db: Database.Database,
  targetVersion: number,
  backupsDir: string,
  filePrefix: string
): Promise<void> {
  const currentVersion = db.pragma('user_version', { simple: true }) as number
  // Fresh DB (v0) has nothing to lose; already-current DB needs no backup.
  if (currentVersion === 0 || currentVersion >= targetVersion) return

  fs.mkdirSync(backupsDir, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filename = `${filePrefix}.${timestamp}.migration.sqlite`

  try {
    await db.backup(path.join(backupsDir, filename))
    console.error(
      `[slayzone] Pre-migration backup: v${currentVersion}→v${targetVersion} → ${filename}`
    )
    cleanupOldMigrationBackups(backupsDir, 3)
  } catch (err) {
    // Backup failure must not block boot — migrations still run.
    console.error(`[slayzone] Pre-migration backup failed (continuing): ${err}`)
  }
}

function cleanupOldMigrationBackups(backupsDir: string, keep: number): void {
  let files: string[]
  try {
    files = fs.readdirSync(backupsDir)
  } catch {
    return
  }
  const migrations = files
    .filter((f) => MIGRATION_BACKUP_REGEX.test(f))
    .map((f) => ({ f, mtime: fs.statSync(path.join(backupsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  for (const { f } of migrations.slice(keep)) {
    try {
      fs.unlinkSync(path.join(backupsDir, f))
    } catch {
      // best-effort
    }
  }
}
