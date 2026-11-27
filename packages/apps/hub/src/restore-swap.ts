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

/**
 * Restoring a backup, split in two halves so the database is never overwritten under
 * an open connection (decision D2):
 *
 *   1. {@link stageRestore}, while the hub runs: the backup is validated and a marker
 *      `<dataRoot>/restore.pending.json` is written durably. The hub then exits with
 *      code 75 and its process manager starts it again.
 *   2. {@link applyPendingRestore}, at the next boot BEFORE the database is opened:
 *      the backup is copied next to the live file, checked, and renamed over it.
 *
 * Crash-safe: the marker records how far the swap got, and every step can run again.
 *   staged → copy backup to `<db>.restore-tmp`, fsync, check it → phase `copied`
 *   copied → delete the live `-wal`/`-shm` (they belong to the old file; a `db.backup()`
 *            artifact is self-contained) → rename tmp over the live file → fsync dir →
 *            delete the marker.
 * The database is never opened while the marker exists, so re-deleting `-wal`/`-shm`
 * after a crash past the rename cannot lose anything the restored file wrote.
 *
 * A backup this build cannot run is REFUSED, before staging and again at boot, with
 * the live database untouched (R1): unreadable or failing `quick_check`, a schema newer
 * than this build (the hub would refuse to boot — a remote hub would stay down), or a
 * cross-hub / cross-computer move in progress (the move engine would resume it from a
 * point in time that no longer matches the other side, R8).
 */
export const RESTORE_MARKER_FILE = 'restore.pending.json'

type Phase = 'staged' | 'copied'
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
  | { status: 'refused'; backup: string; error: string }

/**
 * Boot step: finish a staged restore before the database is opened. Never throws for
 * a bad backup (refused: marker cleared, live database untouched); throws only on an
 * I/O failure mid-swap, which the next boot retries from the recorded phase.
 */
export function applyPendingRestore(input: {
  dataRoot: string
  dbPath: string
  latestVersion: number
  crashAt?: CrashPoint
}): ApplyRestoreResult {
  const { dataRoot, dbPath } = input
  const marker = (() => {
    try {
      return JSON.parse(readFileSync(join(dataRoot, RESTORE_MARKER_FILE), 'utf8')) as Marker
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      return { v: 1, backup: '', phase: 'staged' } as Marker
    }
  })()
  if (!marker) return { status: 'none' }
  const crash = (at: CrashPoint): void => {
    if (input.crashAt === at) throw new Error(`simulated crash after ${at}`)
  }
  const tmp = `${dbPath}.restore-tmp`
  const refuse = (error: string): ApplyRestoreResult => {
    rmSync(tmp, { force: true })
    clearMarker(dataRoot)
    return { status: 'refused', backup: marker.backup, error }
  }

  if (marker.phase !== 'copied') {
    let source: string
    try {
      source = containedPath(backupsDir(dataRoot), marker.backup)
      validateRestoreSource(source, input.latestVersion)
    } catch (err) {
      return refuse((err as Error).message)
    }
    copyFileSync(source, tmp)
    fsyncFileSync(tmp)
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
    for (const suffix of ['-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true })
    crash('sidecars-removed')
    renameSync(tmp, dbPath)
    syncDir(dirname(dbPath))
    crash('renamed')
  } else {
    // Renamed before a crash; the restored file has not been opened since.
    for (const suffix of ['-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true })
  }
  clearMarker(dataRoot)
  return { status: 'applied', backup: marker.backup }
}
