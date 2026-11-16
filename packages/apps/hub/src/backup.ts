import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { sanitizeHubChatBackup } from './chat-backup'
import path from 'node:path'
import type { SlayzoneDb } from '@slayzone/platform'
import { containedPath } from '@slayzone/platform/safe-path'
import {
  createAsyncFaultLedger,
  forEachIsolated,
  isStorageFatal
} from '@slayzone/platform/isolation'
import type { BackupInfo, BackupSettings } from '@slayzone/types'
import {
  createArtifactBackupProtection,
  type ArtifactBackupProtection
} from '@slayzone/task-artifacts/storage'

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
const activeHubSnapshots = new Set<string>()

function collectAbandonedHubSnapshots(dataRoot: string) {
  const dir = backupsDir(dataRoot),
    pending = new Map<string, string | undefined>()
  for (const name of fs.readdirSync(dir)) {
    const match = /^(\.pending-(?:(\d+)-)?[a-f0-9-]{36}\.sqlite)(?:-(?:wal|shm))?$/.exec(name)
    if (match) pending.set(match[1], match[2])
  }
  for (const [name, pid] of pending) {
    const file = path.join(dir, name)
    if (activeHubSnapshots.has(file)) continue
    if (pid && Number(pid) !== process.pid) {
      try {
        process.kill(Number(pid), 0)
        continue
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue
      }
    }
    // Legacy staging had no PID. Only the current hub owns this database; its
    // predecessor is stopped before a replacement can begin writing backups.
    for (const suffix of ['', ...DB_SUFFIXES]) fs.rmSync(file + suffix, { force: true })
  }
}

const DEFAULT_BACKUP_SETTINGS: BackupSettings = {
  autoEnabled: false,
  intervalMinutes: 60,
  maxAutoBackups: 10,
  nextBackupNumber: 1
}

// slayzone.dev.data.2026-03-07T12-30-00-000Z.manual.sqlite
//
// The prefix is the live DB filename minus `.sqlite`: `slayzone.data` / `slayzone.dev.data`
// now, `slayzone` / `slayzone.dev` before the main DB was renamed. Backups made under
// the old prefix are the user's safety net and must keep listing, so `.data` is optional.
// `slayzone.auth.*` and `slayzone.diagnostics.*` deliberately do not match.
const BACKUP_REGEX =
  /^slayzone(?:\.dev)?(?:\.data)?\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.(auto|manual|migration)\.sqlite$/

export type BackupDeps = {
  sanitizeSnapshot?: (path: string) => Promise<void>
  artifactProtection?: ArtifactBackupProtection
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

function syncBackupDirectory(dir: string) {
  if (process.platform === 'win32') return
  const fd = fs.openSync(dir, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
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

/**
 * Resolve a caller-supplied filename strictly inside the backups dir, or throw
 * `UnsafePathError`. A bare `startsWith(dir)` let `../backups-x` (a sibling sharing
 * the prefix) and `''` (the dir itself) through.
 */
function resolveInsideBackups(dataRoot: string, filename: string): string {
  return containedPath(backupsDir(dataRoot), filename)
}

export function buildBackupOps(deps: BackupDeps) {
  const { db, dataRoot } = deps
  collectAbandonedHubSnapshots(dataRoot)
  let autoTimer: ReturnType<typeof setInterval> | null = null
  let lastSnapshotAt = 0,
    restoring = false
  const creations = new Set<Promise<BackupInfo>>()
  const protection =
    deps.artifactProtection ??
    createArtifactBackupProtection(db, dataRoot, (name) => parseBackupFilename(name) !== null)
  // Starts its guard before migration GC can run during composition.
  const prepared = protection.prepare()
  void prepared.catch(() => {
    /* Creation/startup await this same failure. */
  })

  const stopAuto = (): void => {
    if (autoTimer) {
      clearInterval(autoTimer)
      autoTimer = null
    }
  }

  const createSnapshot = async (type: 'auto' | 'manual', name?: string): Promise<BackupInfo> => {
    let filename: string, destPath: string
    do {
      lastSnapshotAt = Math.max(Date.now(), lastSnapshotAt + 1)
      filename = `${filenamePrefix(deps.dbPath)}.${new Date(lastSnapshotAt).toISOString().replace(/[:.]/g, '-')}.${type}.sqlite`
      destPath = path.join(backupsDir(dataRoot), filename)
    } while (fs.existsSync(destPath))
    const pendingPath = path.join(
      backupsDir(dataRoot),
      `.pending-${process.pid}-${randomUUID()}.sqlite`
    )
    await prepared
    const protectedSnapshot = await protection.begin(filename)
    activeHubSnapshots.add(pendingPath)
    let published = false
    try {
      await db.backup(pendingPath)
      await (deps.sanitizeSnapshot ?? sanitizeHubChatBackup)(pendingPath)
      await protectedSnapshot.pinSnapshot(pendingPath)
      fs.renameSync(pendingPath, destPath)
      published = true
      syncBackupDirectory(backupsDir(dataRoot))
    } finally {
      try {
        for (const suffix of ['', ...DB_SUFFIXES]) fs.rmSync(pendingPath + suffix, { force: true })
      } finally {
        activeHubSnapshots.delete(pendingPath)
        await protectedSnapshot.finish(published)
      }
    }
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
  const create = (type: 'auto' | 'manual', name?: string): Promise<BackupInfo> => {
    if (restoring) return Promise.reject(new Error('Hub restore is in progress'))
    const work = createSnapshot(type, name).finally(() => {
      creations.delete(work)
    })
    creations.add(work)
    return work
  }

  const remove = async (filename: string): Promise<void> => {
    const filePath = resolveInsideBackups(dataRoot, filename)
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
      syncBackupDirectory(backupsDir(dataRoot))
    }
    await protection.forget(filename)
    const names = await getBackupNames(db)
    delete names[filename]
    await writeBackupNames(db, names)
  }

  const cleanupOld = async (type: 'auto', max: number): Promise<void> => {
    // 0 = unlimited: what the Settings UI stores for "Unlimited". Without this guard
    // `slice(0)` is every backup, and each tick deleted all of them — including the one
    // it had just made. v0.35.0 had the guard; the hub port dropped it.
    if (max <= 0) return
    const existing = (await listBackups(deps)).filter((b) => b.type === type)
    if (existing.length <= max) return
    // One backup that cannot be removed is recorded and retried next tick; the
    // rest of the rotation still happens.
    await forEachIsolated(
      existing.slice(max),
      {
        pass: 'hub-backup-rotation',
        key: (b) => b.filename,
        ledger: createAsyncFaultLedger(db, { origin: 'hub' }),
        isFatal: isStorageFatal
      },
      (b) => remove(b.filename)
    )
  }

  /** One auto-backup tick: snapshot, then enforce the cap. Settings are read per tick, so
   *  a changed cap applies to the next one without re-arming the timer. */
  const runAutoBackup = async (): Promise<void> => {
    await create('auto')
    await cleanupOld('auto', (await getBackupSettings(db)).maxAutoBackups)
  }

  const startAuto = async (): Promise<void> => {
    await prepared
    stopAuto()
    const settings = await getBackupSettings(db)
    if (!settings.autoEnabled) return
    autoTimer = setInterval(
      async () => {
        try {
          await runAutoBackup()
        } catch (err) {
          console.error('Auto-backup failed:', err)
        }
      },
      settings.intervalMinutes * 60 * 1000
    )
    // The listener keeps the process alive; a timer must not hold up shutdown.
    autoTimer.unref?.()
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
    restoring = true
    await Promise.all(creations)
    await protection.close()
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
    stopAuto,
    prepare: () => prepared,
    close: async () => {
      stopAuto()
      await Promise.allSettled(creations)
      await protection.close()
    },
    runAutoBackup,
    autoRunning: (): boolean => autoTimer !== null
  }
}
