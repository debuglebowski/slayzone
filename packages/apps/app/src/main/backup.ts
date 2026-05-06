import { app, shell } from 'electron'
import type { IpcMain } from 'electron'
import type Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import { getDatabasePath, closeDatabase } from './db'
import type { BackupInfo, BackupSettings } from '@slayzone/types'

const DB_SUFFIXES = ['', '-wal', '-shm'] as const

const DEFAULT_BACKUP_SETTINGS: BackupSettings = {
  autoEnabled: false,
  intervalMinutes: 60,
  maxAutoBackups: 10,
  nextBackupNumber: 1
}

// Filename format: slayzone.dev.2026-03-07T12-30-00-000Z.manual.sqlite
const BACKUP_REGEX = /^slayzone(?:\.dev)?\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.(auto|manual|migration)\.sqlite$/

function getBackupsDir(): string {
  const userDataPath = app.getPath('userData')
  const dir = path.join(userDataPath, 'backups')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function buildBackupFilename(type: 'auto' | 'manual' | 'migration'): string {
  const prefix = app.isPackaged ? 'slayzone' : 'slayzone.dev'
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `${prefix}.${timestamp}.${type}.sqlite`
}

function parseBackupFilename(filename: string): { timestamp: Date; type: 'auto' | 'manual' | 'migration' } | null {
  const match = filename.match(BACKUP_REGEX)
  if (!match) return null
  // Restore ISO format: 2026-03-07T12-30-00-000Z → 2026-03-07T12:30:00.000Z
  const isoStr = match[1].replace(
    /^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/,
    '$1$2:$3:$4.$5'
  )
  const timestamp = new Date(isoStr)
  if (isNaN(timestamp.getTime())) return null
  return { timestamp, type: match[2] as 'auto' | 'manual' | 'migration' }
}

// Backup names stored as JSON map { [filename]: name } in settings table
let _db: Database.Database | null = null

function getBackupNames(): Record<string, string> {
  if (!_db) return {}
  const row = _db.prepare('SELECT value FROM settings WHERE key = ?').get('backup_names') as { value: string } | undefined
  if (!row) return {}
  try { return JSON.parse(row.value) } catch { return {} }
}

function setBackupName(filename: string, name: string): void {
  if (!_db) return
  const names = getBackupNames()
  names[filename] = name
  _db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('backup_names', JSON.stringify(names))
}

function removeBackupName(filename: string): void {
  if (!_db) return
  const names = getBackupNames()
  delete names[filename]
  _db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('backup_names', JSON.stringify(names))
}

function listBackups(): BackupInfo[] {
  const dir = getBackupsDir()
  const files = fs.readdirSync(dir)
  const names = getBackupNames()
  const backups: BackupInfo[] = []
  for (const filename of files) {
    const parsed = parseBackupFilename(filename)
    if (!parsed) continue
    const stat = fs.statSync(path.join(dir, filename))
    backups.push({
      filename,
      name: names[filename] || filename,
      timestamp: parsed.timestamp.toISOString(),
      type: parsed.type,
      sizeBytes: stat.size
    })
  }
  backups.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
  return backups
}

async function createBackup(db: Database.Database, type: 'auto' | 'manual', name?: string): Promise<BackupInfo> {
  const dir = getBackupsDir()
  const filename = buildBackupFilename(type)
  const destPath = path.join(dir, filename)
  await db.backup(destPath)
  const stat = fs.statSync(destPath)

  // Assign name: use provided name, or auto-generate "Backup N"
  const settings = getBackupSettings(db)
  const backupName = name || `Backup ${settings.nextBackupNumber}`
  setBackupName(filename, backupName)
  setBackupSettings(db, { nextBackupNumber: settings.nextBackupNumber + 1 })

  return {
    filename,
    name: backupName,
    timestamp: parseBackupFilename(filename)!.timestamp.toISOString(),
    type,
    sizeBytes: stat.size
  }
}

function deleteBackup(filename: string): void {
  const dir = getBackupsDir()
  const filePath = path.join(dir, filename)
  // Validate path is within backups dir
  if (!path.resolve(filePath).startsWith(path.resolve(dir))) {
    throw new Error('Invalid backup filename')
  }
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath)
  }
  removeBackupName(filename)
}

function restoreBackup(filename: string): void {
  const dir = getBackupsDir()
  const backupPath = path.join(dir, filename)
  if (!path.resolve(backupPath).startsWith(path.resolve(dir))) {
    throw new Error('Invalid backup filename')
  }
  if (!fs.existsSync(backupPath)) {
    throw new Error('Backup file not found')
  }

  const dbPath = getDatabasePath()
  stopAutoBackup()
  closeDatabase()

  // Copy backup over main DB
  fs.copyFileSync(backupPath, dbPath)

  // Remove WAL/SHM files (backup from db.backup() is self-contained)
  for (const suffix of DB_SUFFIXES) {
    if (suffix === '') continue
    const walPath = `${dbPath}${suffix}`
    if (fs.existsSync(walPath)) {
      fs.unlinkSync(walPath)
    }
  }

  app.relaunch()
  app.exit()
}

function getBackupSettings(db: Database.Database): BackupSettings {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('backup_settings') as { value: string } | undefined
  if (!row) return { ...DEFAULT_BACKUP_SETTINGS }
  try {
    return { ...DEFAULT_BACKUP_SETTINGS, ...JSON.parse(row.value) }
  } catch {
    return { ...DEFAULT_BACKUP_SETTINGS }
  }
}

function setBackupSettings(db: Database.Database, partial: Partial<BackupSettings>): BackupSettings {
  const current = getBackupSettings(db)
  const merged = { ...current, ...partial }
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
    'backup_settings',
    JSON.stringify(merged)
  )
  return merged
}

function cleanupOldBackups(type: BackupInfo['type'], max: number): void {
  if (max <= 0) return // 0 = unlimited
  const backups = listBackups().filter((b) => b.type === type)
  if (backups.length <= max) return
  // backups already sorted newest-first
  const toDelete = backups.slice(max)
  for (const backup of toDelete) {
    deleteBackup(backup.filename)
  }
}

let autoBackupTimer: ReturnType<typeof setInterval> | null = null

export function startAutoBackup(db: Database.Database): void {
  stopAutoBackup()
  const settings = getBackupSettings(db)
  if (!settings.autoEnabled) return
  const intervalMs = settings.intervalMinutes * 60 * 1000
  autoBackupTimer = setInterval(async () => {
    try {
      await createBackup(db, 'auto')
      cleanupOldBackups('auto', settings.maxAutoBackups)
    } catch (err) {
      console.error('Auto-backup failed:', err)
    }
  }, intervalMs)
}

export function stopAutoBackup(): void {
  if (autoBackupTimer) {
    clearInterval(autoBackupTimer)
    autoBackupTimer = null
  }
}

export async function createPreMigrationBackup(
  db: Database.Database,
  targetVersion: number
): Promise<void> {
  const currentVersion = db.pragma('user_version', { simple: true }) as number
  if (currentVersion === 0 || currentVersion >= targetVersion) return

  const dir = getBackupsDir()
  const filename = buildBackupFilename('migration')
  try {
    await db.backup(path.join(dir, filename))
    console.error(`[slayzone] Pre-migration backup: v${currentVersion}→v${targetVersion} → ${filename}`)
    cleanupOldBackups('migration', 3)
  } catch (err) {
    console.error(`[slayzone] Pre-migration backup failed (continuing): ${err}`)
  }
}

export function registerBackupHandlers(ipcMain: IpcMain, db: Database.Database): void {
  _db = db

  ipcMain.handle('backup:list', () => {
    return listBackups()
  })

  ipcMain.handle('backup:create', async (_, name?: string) => {
    return createBackup(db, 'manual', name)
  })

  ipcMain.handle('backup:rename', (_, filename: string, name: string) => {
    setBackupName(filename, name)
  })

  ipcMain.handle('backup:delete', (_, filename: string) => {
    deleteBackup(filename)
  })

  ipcMain.handle('backup:restore', (_, filename: string) => {
    restoreBackup(filename)
  })

  ipcMain.handle('backup:getSettings', () => {
    return getBackupSettings(db)
  })

  ipcMain.handle('backup:setSettings', (_, partial: Partial<BackupSettings>) => {
    const updated = setBackupSettings(db, partial)
    startAutoBackup(db)
    return updated
  })

  ipcMain.handle('backup:revealInFinder', () => {
    shell.openPath(getBackupsDir())
  })
}
