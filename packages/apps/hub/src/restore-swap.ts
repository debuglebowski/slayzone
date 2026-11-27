import Database from 'better-sqlite3'
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fsyncFileSync } from '@slayzone/platform/durable-fs'
import { containedPath } from '@slayzone/platform/safe-path'
import { startNewDataGeneration } from '@slayzone/platform/hub-data-generation'

/**
 * Restoring a backup, split so the database is never overwritten under an open
 * connection (decision D2), and never lost if the backup will not start:
 *
 *   1. {@link stageRestore}, while the hub runs: the backup is validated and a marker
 *      `<dataRoot>/restore.pending.json` is written durably. The hub then exits with
 *      code 75 and its process manager starts it again.
 *   2. {@link applyPendingRestore}, at the next boot BEFORE the database is opened:
 *      the backup is copied next to the live file and checked; the live file (with
 *      its `-wal`/`-shm`) is moved ASIDE to `<db>.pre-restore`, not deleted, and the
 *      copy renamed into place.
 *   3. The hub opens the restored file (migrations run). Success →
 *      {@link confirmRestore}: the old file goes, a new data generation starts.
 *      Failure → {@link rollbackRestore}: the old file is put back as it was and the
 *      refusal is reported (Needs attention). A boot that finds a swap still
 *      unconfirmed (the start before died on it) rolls back too.
 *
 * Crash-safe: the marker records the phase and every step can run again.
 *   staged  → copy backup to `<db>.restore-tmp`, fsync, check     → copied
 *   copied  → move the live file aside, rename tmp over it, fsync → swapped
 *   swapped → (next boot, unconfirmed) roll back
 * The database is never opened while the marker says `staged` or `copied`.
 *
 * Refused — nothing changed, marker cleared, so a refusal never loops: a backup this
 * build cannot run (unreadable, failing `quick_check`, a schema newer than this
 * build, a move in progress — R1, R8), a file that is not a data backup (L3), and
 * any I/O error while copying it (a full disk, M2).
 */
export const RESTORE_MARKER_FILE = 'restore.pending.json'

/**
 * A data-DB backup's file name (`<prefix>.<ISO ts>.<type>.sqlite`). The one source:
 * backup.ts lists with it, and only such a file may be restored (L3) — never the auth
 * or diagnostics database, or any other SQLite file someone put in `backups/`.
 */
export const BACKUP_FILENAME_REGEX =
  /^slayzone(?:\.dev)?(?:\.data)?\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.(auto|manual|migration|restore)\.sqlite$/

function assertDataBackupName(filename: string): void {
  if (!BACKUP_FILENAME_REGEX.test(filename)) {
    throw new RestoreRefusedError('missing', `${filename} is not a backup of this hub's data`)
  }
}

/** Where the live file waits while the restored one proves it starts. */
function preRestorePath(dbPath: string): string {
  return `${dbPath}.pre-restore`
}
const SIDECARS = ['-wal', '-shm'] as const

type Phase = 'staged' | 'copied' | 'swapped'
type Marker = { v: 1; backup: string; phase: Phase; stagedAt?: number }

export type RestoreRefusalCode = 'missing' | 'corrupt' | 'too-new' | 'move-in-progress'

export class RestoreRefusedError extends Error {
  constructor(
    readonly code: RestoreRefusalCode,
    message: string
  ) {
    super(message)
    this.name = 'RestoreRefusedError'
  }
}

/** Test seam: throw after a step to prove the next boot finishes the swap. */
type CrashPoint = 'copied' | 'staged-recorded' | 'sidecars-removed' | 'renamed'

function backupsDir(dataRoot: string): string {
  return join(dataRoot, 'backups')
}

function syncDir(dir: string): void {
  if (process.platform === 'win32') return
  const fd = openSync(dir, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function writeMarker(dataRoot: string, marker: Marker): void {
  const path = join(dataRoot, RESTORE_MARKER_FILE)
  const tmp = `${path}.tmp`
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeSync(fd, JSON.stringify(marker))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
  syncDir(dataRoot)
}

function clearMarker(dataRoot: string): void {
  rmSync(join(dataRoot, RESTORE_MARKER_FILE), { force: true })
  rmSync(join(dataRoot, `${RESTORE_MARKER_FILE}.tmp`), { force: true })
  syncDir(dataRoot)
}

/** The staged restore, if any (Settings shows it; boot applies it). */
export function pendingRestore(dataRoot: string): { backup: string; phase: Phase } | null {
  try {
    const m = JSON.parse(readFileSync(join(dataRoot, RESTORE_MARKER_FILE), 'utf8')) as Marker
    return m?.v === 1 && typeof m.backup === 'string' ? { backup: m.backup, phase: m.phase } : null
  } catch {
    return null
  }
}

/** A cross-hub move (`task_moves`) or a move between computers (`task_computer_moves`)
 *  that has not finished: running, paused or failed (failed ones are resumable). */
export const ACTIVE_MOVE_QUERIES: Readonly<Record<string, string>> = {
  task_moves: "SELECT COUNT(*) AS n FROM task_moves WHERE status NOT IN ('done', 'canceled')",
  task_computer_moves:
    "SELECT COUNT(*) AS n FROM task_computer_moves WHERE status NOT IN ('done', 'canceled')"
}

/** Unfinished moves in an open database (tables absent in older schemas count 0). */
function countActiveMoves(db: Database.Database): number {
  let n = 0
  for (const [table, sql] of Object.entries(ACTIVE_MOVE_QUERIES)) {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table)
    if (exists) n += (db.prepare(sql).get() as { n: number }).n
  }
  return n
}

/**
 * Throws {@link RestoreRefusedError} unless `path` is a database this build can run.
 * Opened read-only: the file is left byte-identical.
 */
export function validateRestoreSource(path: string, latestVersion: number): void {
  if (!existsSync(path)) throw new RestoreRefusedError('missing', 'Backup file not found')
  // A read-only reader of a WAL-mode file still creates empty `-wal`/`-shm` next to it
  // and cannot remove them: remove the ones this check created, so a backups dir holds
  // only backups.
  const created = ['-wal', '-shm'].filter((s) => !existsSync(`${path}${s}`))
  try {
    checkDatabase(path, latestVersion)
  } finally {
    for (const s of created) rmSync(`${path}${s}`, { force: true })
  }
}

function checkDatabase(path: string, latestVersion: number): void {
  let db: Database.Database
  try {
    db = new Database(path, { readonly: true, fileMustExist: true })
  } catch (err) {
    throw new RestoreRefusedError('corrupt', `Backup cannot be opened: ${(err as Error).message}`)
  }
  try {
    let check: unknown
    let version: number
    try {
      check = db.pragma('quick_check', { simple: true })
      version = db.pragma('user_version', { simple: true }) as number
    } catch (err) {
      throw new RestoreRefusedError(
        'corrupt',
        `Backup is not a database: ${(err as Error).message}`
      )
    }
    if (check !== 'ok') {
      throw new RestoreRefusedError(
        'corrupt',
        `Backup failed its integrity check: ${String(check)}`
      )
    }
    if (version > latestVersion) {
      throw new RestoreRefusedError(
        'too-new',
        `Backup schema v${version} is newer than this hub supports (v${latestVersion}). Upgrade the hub first.`
      )
    }
    if (countActiveMoves(db) > 0) {
      throw new RestoreRefusedError(
        'move-in-progress',
        'Backup was taken while a move was in progress; restoring it would resume that move.'
      )
    }
  } finally {
    db.close()
  }
}

/** Stage a restore of `<dataRoot>/backups/<backupFilename>` for the next boot. */
export function stageRestore(input: { dataRoot: string; backupFilename: string }): void {
  containedPath(backupsDir(input.dataRoot), input.backupFilename)
  assertDataBackupName(input.backupFilename)
  mkdirSync(input.dataRoot, { recursive: true })
  writeMarker(input.dataRoot, {
    v: 1,
    backup: input.backupFilename,
    phase: 'staged',
    stagedAt: Date.now()
  })
}

export type ApplyRestoreResult =
  | { status: 'none' }
  | { status: 'applied'; backup: string }
  /** Swapped in, not yet proven to start: {@link confirmRestore} or {@link rollbackRestore}. */
  | { status: 'applied-unverified'; backup: string }
  | { status: 'refused'; backup: string; error: string }

type CopyFile = (source: string, dest: string) => void

function readMarker(dataRoot: string): Marker | null {
  try {
    return JSON.parse(readFileSync(join(dataRoot, RESTORE_MARKER_FILE), 'utf8')) as Marker
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    // Unreadable marker: refused below (an empty name is no backup).
    return { v: 1, backup: '', phase: 'staged' }
  }
}

function moveIfPresent(from: string, to: string): void {
  if (existsSync(from)) renameSync(from, to)
}

/**
 * Boot step: bring a staged restore as far as "swapped", before the database is
 * opened. Never throws for a bad backup or a failed copy (refused: marker cleared,
 * live database untouched); throws only on an I/O failure AFTER the copy succeeded,
 * which the next boot resumes from the recorded phase.
 */
export function applyPendingRestore(input: {
  dataRoot: string
  dbPath: string
  latestVersion: number
  crashAt?: CrashPoint
  /** Test seam (a full disk); default `copyFileSync`. */
  copyFile?: CopyFile
}): ApplyRestoreResult {
  const { dataRoot, dbPath } = input
  const marker = readMarker(dataRoot)
  if (!marker) return { status: 'none' }
  const crash = (at: CrashPoint): void => {
    if (input.crashAt === at) throw new Error(`simulated crash after ${at}`)
  }
  const tmp = `${dbPath}.restore-tmp`
  const refuse = (error: string): ApplyRestoreResult => {
    rmSync(tmp, { force: true })
    for (const s of SIDECARS) rmSync(`${tmp}${s}`, { force: true })
    clearMarker(dataRoot)
    return { status: 'refused', backup: marker.backup, error }
  }

  if (marker.phase === 'swapped') {
    // The boot that swapped it in never confirmed it: that start died on the restored
    // file. Put the old data back rather than fail every start from here on.
    return rollbackRestore({
      dataRoot,
      dbPath,
      error: 'The restored backup did not start (the previous start with it did not finish)'
    })
  }

  if (marker.phase !== 'copied') {
    try {
      assertDataBackupName(marker.backup)
      const source = containedPath(backupsDir(dataRoot), marker.backup)
      validateRestoreSource(source, input.latestVersion)
      ;(input.copyFile ?? copyFileSync)(source, tmp)
      fsyncFileSync(tmp)
    } catch (err) {
      // Any failure here — a bad backup, a full disk, a permission — refuses: the
      // live file was never touched, and retrying at every start would only loop.
      const e = err as NodeJS.ErrnoException
      const why =
        e?.code === 'ENOSPC'
          ? `Not enough disk space to restore it (${e.message})`
          : (e?.message ?? String(err))
      return refuse(why)
    }
    try {
      validateRestoreSource(tmp, input.latestVersion)
    } catch (err) {
      return refuse(`copy failed its check: ${(err as Error).message}`)
    }
    crash('copied')
    writeMarker(dataRoot, { ...marker, phase: 'copied' })
    crash('staged-recorded')
  }

  if (existsSync(tmp)) {
    // The live file and its WAL/SHM move aside TOGETHER (a WAL belongs to its file).
    const aside = preRestorePath(dbPath)
    if (existsSync(dbPath)) {
      for (const s of SIDECARS) moveIfPresent(`${dbPath}${s}`, `${aside}${s}`)
      crash('sidecars-removed')
      renameSync(dbPath, aside)
    }
    renameSync(tmp, dbPath)
    syncDir(dirname(dbPath))
    crash('renamed')
  }
  // tmp gone = renamed before a crash; the restored file has not been opened since.
  writeMarker(dataRoot, { ...marker, phase: 'swapped' })
  return { status: 'applied-unverified', backup: marker.backup }
}

/**
 * The restored file opened and migrated: the swap is final. The old file goes, a new
 * data generation starts (every client reloads), the marker is cleared.
 */
export function confirmRestore(input: { dataRoot: string; dbPath: string }): ApplyRestoreResult {
  const marker = readMarker(input.dataRoot)
  if (!marker || marker.phase !== 'swapped') return { status: 'none' }
  const aside = preRestorePath(input.dbPath)
  // Before the marker goes: a crash in between starts one more generation, harmless.
  startNewDataGeneration(input.dataRoot)
  for (const s of ['', ...SIDECARS]) rmSync(`${aside}${s}`, { force: true })
  clearMarker(input.dataRoot)
  return { status: 'applied', backup: marker.backup }
}

/**
 * The restored file did not start: put the old one back exactly as it was (with its
 * WAL/SHM) and report the refusal. The restored copy is dropped — the backup it came
 * from is untouched in `backups/`.
 */
export function rollbackRestore(input: {
  dataRoot: string
  dbPath: string
  error: string
}): ApplyRestoreResult {
  const marker = readMarker(input.dataRoot)
  const backup = marker?.backup ?? ''
  const aside = preRestorePath(input.dbPath)
  if (existsSync(aside)) {
    for (const s of ['', ...SIDECARS]) rmSync(`${input.dbPath}${s}`, { force: true })
    for (const s of SIDECARS) moveIfPresent(`${aside}${s}`, `${input.dbPath}${s}`)
    renameSync(aside, input.dbPath)
    syncDir(dirname(input.dbPath))
  }
  clearMarker(input.dataRoot)
  return {
    status: 'refused',
    backup,
    error: `${input.error}. Your previous data was put back.`
  }
}
