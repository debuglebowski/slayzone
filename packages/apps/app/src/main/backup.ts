import { app, shell } from 'electron'
import type { IpcMain } from 'electron'
import type { SlayzoneDb } from '@slayzone/platform'
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
const BACKUP_REGEX =
  /^slayzone(?:\.dev)?\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.(auto|manual|migration)\.sqlite$/

function getBackupsDir(): string {
  const userDataPath = process.env.SLAYZONE_DB_DIR || app.getPath('userData')
  const dir = path.join(userDataPath, 'backups')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function buildBackupFilename(type: 'auto' | 'manual' | 'migration'): string {
  const prefix = app.isPackaged ? 'slayzone' : 'slayzone.dev'
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `${prefix}.${timestamp}.${type}.sqlite`
}

function parseBackupFilename(
  filename: string
): { timestamp: Date; type: 'auto' | 'manual' | 'migration' } | null {
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
let _db: SlayzoneDb | null = null

async function getBackupNames(): Promise<Record<string, string>> {
  if (!_db) return {}
  const row = (await _db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get('backup_names')) as { value: string } | undefined
  if (!row) return {}
  try {
    return JSON.parse(row.value)
  } catch {
    return {}
  }
}

async function setBackupName(filename: string, name: string): Promise<void> {
  if (!_db) return
  const names = await getBackupNames()
  names[filename] = name
  await _db
    .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run('backup_names', JSON.stringify(names))
}

async function removeBackupName(filename: string): Promise<void> {
  if (!_db) return
  const names = await getBackupNames()
  delete names[filename]
  await _db
    .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run('backup_names', JSON.stringify(names))
}

async function listBackups(): Promise<BackupInfo[]> {
  const dir = getBackupsDir()
  const files = fs.readdirSync(dir)
  const names = await getBackupNames()
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

async function createBackup(
  db: SlayzoneDb,
  type: 'auto' | 'manual',
  name?: string
): Promise<BackupInfo> {
  const dir = getBackupsDir()
  const filename = buildBackupFilename(type)
  const destPath = path.join(dir, filename)
  await db.backup(destPath)
  const stat = fs.statSync(destPath)

  // Assign name: use provided name, or auto-generate "Backup N"
  const settings = await getBackupSettings(db)
  const backupName = name || `Backup ${settings.nextBackupNumber}`
  await setBackupName(filename, backupName)
  await setBackupSettings(db, { nextBackupNumber: settings.nextBackupNumber + 1 })

  return {
    filename,
    name: backupName,
    timestamp: parseBackupFilename(filename)!.timestamp.toISOString(),
    type,
    sizeBytes: stat.size
  }
}

async function deleteBackup(filename: string): Promise<void> {
  const dir = getBackupsDir()
  const filePath = path.join(dir, filename)
  // Validate path is within backups dir
  if (!path.resolve(filePath).startsWith(path.resolve(dir))) {
    throw new Error('Invalid backup filename')
  }
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath)
  }
  await removeBackupName(filename)
}

async function restoreBackup(filename: string): Promise<void> {
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
  await closeDatabase()

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

async function getBackupSettings(db: SlayzoneDb): Promise<BackupSettings> {
  const row = (await db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get('backup_settings')) as { value: string } | undefined
  if (!row) return { ...DEFAULT_BACKUP_SETTINGS }
  try {
    return { ...DEFAULT_BACKUP_SETTINGS, ...JSON.parse(row.value) }
  } catch {
    return { ...DEFAULT_BACKUP_SETTINGS }
  }
}

async function setBackupSettings(
  db: SlayzoneDb,
  partial: Partial<BackupSettings>
): Promise<BackupSettings> {
  const current = await getBackupSettings(db)
  const merged = { ...current, ...partial }
  await db
    .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run('backup_settings', JSON.stringify(merged))
  return merged
}

async function cleanupOldBackups(type: BackupInfo['type'], max: number): Promise<void> {
  if (max <= 0) return // 0 = unlimited
  const backups = (await listBackups()).filter((b) => b.type === type)
  if (backups.length <= max) return
  // backups already sorted newest-first
  const toDelete = backups.slice(max)
  for (const backup of toDelete) {
    await deleteBackup(backup.filename)
  }
}

let autoBackupTimer: ReturnType<typeof setInterval> | null = null

export async function startAutoBackup(db: SlayzoneDb): Promise<void> {
  stopAutoBackup()
  const settings = await getBackupSettings(db)
  if (!settings.autoEnabled) return
  const intervalMs = settings.intervalMinutes * 60 * 1000
  autoBackupTimer = setInterval(async () => {
    try {
      await createBackup(db, 'auto')
      await cleanupOldBackups('auto', settings.maxAutoBackups)
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

export function registerBackupHandlers(ipcMain: IpcMain, db: SlayzoneDb): void {
  _db = db

  ipcMain.handle('backup:list', () => {
    return listBackups()
  })

  ipcMain.handle('backup:create', async (_, name?: string) => {
    return createBackup(db, 'manual', name)
  })

  ipcMain.handle('backup:rename', (_, filename: string, name: string) => {
    return setBackupName(filename, name)
  })

  ipcMain.handle('backup:delete', (_, filename: string) => {
    return deleteBackup(filename)
  })

  ipcMain.handle('backup:restore', (_, filename: string) => {
    return restoreBackup(filename)
  })

  ipcMain.handle('backup:getSettings', () => {
    return getBackupSettings(db)
  })

  ipcMain.handle('backup:setSettings', async (_, partial: Partial<BackupSettings>) => {
    const updated = await setBackupSettings(db, partial)
    await startAutoBackup(db)
    return updated
  })

  ipcMain.handle('backup:revealInFinder', () => {
    shell.openPath(getBackupsDir())
  })
}
