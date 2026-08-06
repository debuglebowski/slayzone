import fs from 'node:fs'
import path from 'node:path'
import type { SlayzoneDb } from '@slayzone/platform'
import type { BackupInfo, BackupSettings } from '@slayzone/types'

/**
 * Backup, owned by the process that owns the database.
 *
 * `db.backup()` snapshots a LIVE connection, so this had to follow the connection
 * when schema ownership moved here. It lived in `apps/app/src/main` behind eight
 * AppDeps slots; its real Electron surface is two calls — `app.relaunch()` and
 * `shell.openPath()` — both injected below. A standalone hub had no backup at all
 * before this (the slots were fail-loud stubs), so the move turns the feature on.
 *
 * Everything ambient in the original is a parameter now. The db handle used to be
 * a module-level `_db` assigned as a side effect of `buildBackupOps`, and the paths
 * came from Electron globals. Injecting them is what makes the restore sequence
 * testable — and for an operation that overwrites the whole database, testable is
 * not optional.
 */

const DB_SUFFIXES = ['-wal', '-shm'] as const

const DEFAULT_BACKUP_SETTINGS: BackupSettings = {
  autoEnabled: false,
  intervalMinutes: 60,
  maxAutoBackups: 10,
  nextBackupNumber: 1
}

// slayzone.dev.2026-03-07T12-30-00-000Z.manual.sqlite
const BACKUP_REGEX =
  /^slayzone(?:\.dev)?\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.(auto|manual|migration)\.sqlite$/

export type BackupDeps = {
  db: SlayzoneDb
  /** Hub data root; backups live in `<dataRoot>/backups`. */
  dataRoot: string
  /** The live database file this hub opened. */
  dbPath: string
  /**
   * Supervised = this hub is the desktop app's own side-car. Restore is refused
   * when false: it overwrites the whole database and relaunches the desktop, and
   * on a hub a client merely connects to, that would silently overwrite everyone's
   * data with semantics ("relaunch") that do not apply to a server it does not run.
   */
  supervised: boolean
  /** Close this hub's own connection before the file is overwritten. */
  closeDb: () => Promise<void>
  appRelaunch: () => void
  shellOpenPath: (p: string) => void
}

function backupsDir(dataRoot: string): string {
  const dir = path.join(dataRoot, 'backups')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Derived from the live DB filename so a backup can never be named for a
 *  different channel than the file it backs up. */
function filenamePrefix(dbPath: string): string {
  return path.basename(dbPath).replace(/\.sqlite$/, '')
}

function buildBackupFilename(dbPath: string, type: 'auto' | 'manual' | 'migration'): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `${filenamePrefix(dbPath)}.${timestamp}.${type}.sqlite`
}

function parseBackupFilename(
  filename: string
): { timestamp: Date; type: 'auto' | 'manual' | 'migration' } | null {
  const match = filename.match(BACKUP_REGEX)
  if (!match) return null
  const isoStr = match[1].replace(
    /^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/,
    '$1$2:$3:$4.$5'
  )
  const timestamp = new Date(isoStr)
  if (isNaN(timestamp.getTime())) return null
  return { timestamp, type: match[2] as 'auto' | 'manual' | 'migration' }
}

// Backup display names live as a JSON map in `settings.backup_names`.
async function getBackupNames(db: SlayzoneDb): Promise<Record<string, string>> {
  const row = (await db.prepare('SELECT value FROM settings WHERE key = ?').get('backup_names')) as
    | { value: string }
    | undefined
  if (!row) return {}
  try {
    return JSON.parse(row.value)
  } catch {
    return {}
  }
}

async function writeBackupNames(db: SlayzoneDb, names: Record<string, string>): Promise<void> {
  await db
    .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run('backup_names', JSON.stringify(names))
}

async function getBackupSettings(db: SlayzoneDb): Promise<BackupSettings> {
  const row = (await db.prepare('SELECT value FROM settings WHERE key = ?').get(
    'backup_settings'
  )) as { value: string } | undefined
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
  const updated = { ...(await getBackupSettings(db)), ...partial }
  await db
    .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run('backup_settings', JSON.stringify(updated))
  return updated
}

async function listBackups(deps: BackupDeps): Promise<BackupInfo[]> {
  const dir = backupsDir(deps.dataRoot)
  const names = await getBackupNames(deps.db)
  const out: BackupInfo[] = []
  for (const filename of fs.readdirSync(dir)) {
    const parsed = parseBackupFilename(filename)
    if (!parsed) continue
    out.push({
      filename,
      name: names[filename] || filename,
      timestamp: parsed.timestamp.toISOString(),
      type: parsed.type,
      sizeBytes: fs.statSync(path.join(dir, filename)).size
    })
  }
  out.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
  return out
}

/** Resolve a caller-supplied filename inside the backups dir, or throw. */
function resolveInsideBackups(dataRoot: string, filename: string): string {
  const dir = backupsDir(dataRoot)
  const filePath = path.join(dir, filename)
  if (!path.resolve(filePath).startsWith(path.resolve(dir))) {
    throw new Error('Invalid backup filename')
  }
  return filePath
}

export function buildBackupOps(deps: BackupDeps) {
  const { db, dataRoot } = deps
  let autoTimer: ReturnType<typeof setInterval> | null = null

  const stopAuto = (): void => {
    if (autoTimer) {
      clearInterval(autoTimer)
      autoTimer = null
    }
  }

  const create = async (type: 'auto' | 'manual', name?: string): Promise<BackupInfo> => {
    const filename = buildBackupFilename(deps.dbPath, type)
    const destPath = path.join(backupsDir(dataRoot), filename)
    await db.backup(destPath)
    const settings = await getBackupSettings(db)
    const backupName = name || `Backup ${settings.nextBackupNumber}`
    const names = await getBackupNames(db)
    names[filename] = backupName
    await writeBackupNames(db, names)
    await setBackupSettings(db, { nextBackupNumber: settings.nextBackupNumber + 1 })
    return {
      filename,
      name: backupName,
      timestamp: parseBackupFilename(filename)!.timestamp.toISOString(),
      type,
      sizeBytes: fs.statSync(destPath).size
    }
  }

  const remove = async (filename: string): Promise<void> => {
    const filePath = resolveInsideBackups(dataRoot, filename)
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    const names = await getBackupNames(db)
    delete names[filename]
    await writeBackupNames(db, names)
  }

  const cleanupOld = async (type: 'auto', max: number): Promise<void> => {
    const existing = (await listBackups(deps)).filter((b) => b.type === type)
    if (existing.length <= max) return
    for (const b of existing.slice(max)) await remove(b.filename)
  }

  const startAuto = async (): Promise<void> => {
    stopAuto()
    const settings = await getBackupSettings(db)
    if (!settings.autoEnabled) return
    autoTimer = setInterval(
      async () => {
        try {
          await create('auto')
          await cleanupOld('auto', settings.maxAutoBackups)
        } catch (err) {
          console.error('Auto-backup failed:', err)
        }
      },
      settings.intervalMinutes * 60 * 1000
    )
  }

  /**
   * ORDER IS LOAD-BEARING AND IRREVERSIBLE.
   *
   * The relaunch kills this process (the side-car is the desktop's child), so
   * anything sequenced after it may simply not run. Close the connection before
   * overwriting the file it points at, drop the stale -wal/-shm (a `db.backup()`
   * artifact is self-contained, so leaving them would corrupt the restore), and
   * relaunch LAST.
   */
  const restore = async (filename: string): Promise<void> => {
    if (!deps.supervised) {
      throw new Error(
        'Restore is only available on your local hub — it overwrites the entire database and restarts the app.'
      )
    }
    const backupPath = resolveInsideBackups(dataRoot, filename)
    if (!fs.existsSync(backupPath)) throw new Error('Backup file not found')

    stopAuto()
    await deps.closeDb()
    fs.copyFileSync(backupPath, deps.dbPath)
    for (const suffix of DB_SUFFIXES) {
      const sidecarFile = `${deps.dbPath}${suffix}`
      if (fs.existsSync(sidecarFile)) fs.unlinkSync(sidecarFile)
    }
    deps.appRelaunch()
  }

  return {
    list: (): Promise<BackupInfo[]> => listBackups(deps),
    create: (name?: string): Promise<BackupInfo> => create('manual', name),
    rename: async (filename: string, name: string): Promise<void> => {
      const names = await getBackupNames(db)
      names[filename] = name
      await writeBackupNames(db, names)
    },
    delete: remove,
    restore,
    getSettings: (): Promise<BackupSettings> => getBackupSettings(db),
    setSettings: async (partial: Partial<BackupSettings>): Promise<BackupSettings> => {
      const updated = await setBackupSettings(db, partial)
      await startAuto()
      return updated
    },
    revealInFinder: (): void => deps.shellOpenPath(backupsDir(dataRoot)),
    startAuto,
    stopAuto
  }
}
