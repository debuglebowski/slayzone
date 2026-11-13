import type { Database } from 'better-sqlite3'
import { randomUUID, createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  statSync
} from 'node:fs'
import path from 'node:path'
import { fsyncFileSync } from '@slayzone/platform/durable-fs'
import { isPathSafeId } from '@slayzone/platform/safe-path'
import {
  forEachIsolatedSync,
  isStorageFatal,
  StructuralFaultError
} from '@slayzone/platform/isolation'
import { quarantineMove } from '@slayzone/platform/quarantine'
import { artifactFilePathIn, artifactsDirOf } from '@slayzone/task/server/artifact-paths'

interface FileChange {
  taskId: string
  /** Set when the artifact moves to `taskId` from another task's directory. */
  previousTaskId?: string
  artifactId: string
  previousTitle: string
  title: string
  hadOriginal: boolean
  sequence: number
}

export const workingCopyJournalDir = (dataDir: string) =>
  path.join(artifactsDirOf(dataDir), '.transactions')

function syncDirectory(dir: string): void {
  if (process.platform === 'win32') return
  const fd = openSync(dir, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function save(file: string, bytes: Buffer | string): void {
  const fd = openSync(file, 'wx', 0o600)
  try {
    writeFileSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function saveCopy(file: string, source: string): void {
  copyFileSync(source, file, constants.COPYFILE_FICLONE)
  // The copy inherits the source's mode. Normalize to save()'s private 0o600: on Windows a
  // read-only attribute blocks both the flush handle and a later rename over the working file.
  chmodSync(file, 0o600)
  fsyncFileSync(file)
}

function sameContents(left: string, right: string): boolean {
  if (statSync(left).size !== statSync(right).size) return false
  const digest = (file: string) => {
    const hash = createHash('sha256'),
      fd = openSync(file, 'r'),
      buffer = Buffer.allocUnsafe(256 * 1024)
    try {
      let count: number
      while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0)
        hash.update(buffer.subarray(0, count))
    } finally {
      closeSync(fd)
    }
    return hash.digest('hex')
  }
  return digest(left) === digest(right)
}

function manifest(dir: string): FileChange | null {
  const file = path.join(dir, 'manifest.json')
  if (!existsSync(file)) return null // Publication never starts before this file is durable.
  const value = JSON.parse(readFileSync(file, 'utf8')) as FileChange
  if (
    !value ||
    typeof value !== 'object' ||
    !isPathSafeId(value.taskId) ||
    (value.previousTaskId !== undefined && !isPathSafeId(value.previousTaskId)) ||
    !isPathSafeId(value.artifactId) ||
    typeof value.previousTitle !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.hadOriginal !== 'boolean' ||
    !Number.isSafeInteger(value.sequence)
  )
    throw new StructuralFaultError('Invalid artifact file journal')
  return value
}

/** Quarantine pass for journals that cannot be read (see `@slayzone/platform/quarantine`). */
export const ARTIFACT_JOURNAL_QUARANTINE_PASS = 'artifact-file-journal'

/**
 * A journal whose manifest cannot be read names no file to restore. Its bytes
 * (a possible before-image) move into quarantine instead of blocking every later
 * file mutation; erasure deletes them by task id, Discard deletes them.
 */
function quarantineJournal(dataDir: string, dir: string, error: Error): void {
  quarantineMove(dataDir, {
    pass: ARTIFACT_JOURNAL_QUARANTINE_PASS,
    path: dir,
    reason: error.message
  })
}

/** A journal's manifest, or the error that makes it unreadable. */
function readJournal(dir: string): { change: FileChange | null } | { error: Error } {
  try {
    return { change: manifest(dir) }
  } catch (raw) {
    if (isStorageFatal(raw)) throw raw
    return { error: raw instanceof Error ? raw : new Error(String(raw)) }
  }
}

export function ensureWorkingCopySchema(db: Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS artifact_file_commits(operation_id TEXT PRIMARY KEY)')
}

/**
 * A commit marker shares the SQLite transaction with the version pointer. The
 * fsynced before-image survives a rollback/process death after file publication.
 * Recovery runs under the same SQLite writer lock before another file mutation.
 */
export function publishWorkingCopy(
  db: Database,
  dataDir: string,
  change: Omit<FileChange, 'hadOriginal' | 'sequence'>,
  bytes: Buffer | { sourcePath: string }
): void {
  const root = workingCopyJournalDir(dataDir),
    operationId = randomUUID(),
    dir = path.join(root, operationId)
  const oldPath = artifactFilePathIn(
    artifactsDirOf(dataDir),
    change.previousTaskId ?? change.taskId,
    change.artifactId,
    change.previousTitle
  )
  const newPath = artifactFilePathIn(
    artifactsDirOf(dataDir),
    change.taskId,
    change.artifactId,
    change.title
  )
  const hadOriginal = existsSync(oldPath)
  const sequence = Number(
    db.prepare('INSERT INTO artifact_file_commits(operation_id) VALUES(?)').run(operationId)
      .lastInsertRowid
  )
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (hadOriginal) saveCopy(path.join(dir, 'before'), oldPath)
  if (Buffer.isBuffer(bytes)) save(path.join(dir, 'after'), bytes)
  else saveCopy(path.join(dir, 'after'), bytes.sourcePath)
  save(path.join(dir, 'manifest.tmp'), JSON.stringify({ ...change, hadOriginal, sequence }))
  renameSync(path.join(dir, 'manifest.tmp'), path.join(dir, 'manifest.json'))
  syncDirectory(dir)
  syncDirectory(root)
  syncDirectory(path.dirname(root))
  mkdirSync(path.dirname(newPath), { recursive: true, mode: 0o700 })
  const pending = path.join(dir, 'publish')
  saveCopy(pending, path.join(dir, 'after'))
  renameSync(pending, newPath)
  if (newPath !== oldPath) rmSync(oldPath, { force: true })
  syncDirectory(path.dirname(newPath))
}

/** Called only with the writer lock, after any enclosing transaction has ended. */
export function recoverWorkingCopies(db: Database, dataDir: string): void {
  const root = workingCopyJournalDir(dataDir)
  if (!existsSync(root)) {
    db.prepare('DELETE FROM artifact_file_commits').run()
    return
  }
  const entries: Array<{ name: string; change: FileChange | null }> = []
  forEachIsolatedSync(
    readdirSync(root, { withFileTypes: true }).filter(
      (entry) => entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name)
    ),
    { pass: 'artifact-file-journal-read', key: (entry) => entry.name, isFatal: isStorageFatal },
    (entry) => {
      const dir = path.join(root, entry.name)
      const read = readJournal(dir)
      if ('error' in read) {
        // The unreadable journal alone is set aside; its quarantine entry is the record.
        quarantineJournal(dataDir, dir, read.error)
        db.prepare('DELETE FROM artifact_file_commits WHERE operation_id=?').run(entry.name)
      } else entries.push({ name: entry.name, change: read.change })
    }
  )
  entries.sort((a, b) => (b.change?.sequence ?? 0) - (a.change?.sequence ?? 0))
  forEachIsolatedSync(
    entries,
    {
      pass: 'artifact-file-journal-recovery',
      key: (entry) => entry.name,
      isFatal: isStorageFatal
    },
    (entry) => {
      const dir = path.join(root, entry.name),
        change = entry.change
      if (!existsSync(dir)) return
      try {
        recoverJournal(entry.name, dir, change)
      } catch (error) {
        // A journal missing its own before/after image can never be replayed.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && existsSync(dir)) {
          quarantineJournal(dataDir, dir, error as Error)
          db.prepare('DELETE FROM artifact_file_commits WHERE operation_id=?').run(entry.name)
          return
        }
        throw error
      }
    }
  )
  function recoverJournal(name: string, dir: string, change: FileChange | null) {
    const committed = db
      .prepare('SELECT 1 FROM artifact_file_commits WHERE operation_id=?')
      .get(name)
    if (change && !committed) {
      const oldPath = artifactFilePathIn(
        artifactsDirOf(dataDir),
        change.previousTaskId ?? change.taskId,
        change.artifactId,
        change.previousTitle
      )
      const newPath = artifactFilePathIn(
        artifactsDirOf(dataDir),
        change.taskId,
        change.artifactId,
        change.title
      )
      const laterEdit = existsSync(newPath) && !sameContents(newPath, path.join(dir, 'after'))
      const previousEdited =
        oldPath !== newPath &&
        existsSync(oldPath) &&
        change.hadOriginal &&
        !sameContents(oldPath, path.join(dir, 'before'))
      if (oldPath === newPath && laterEdit) {
        // The failed publication no longer owns these bytes. A later external
        // editor change remains an ordinary unsaved working copy of the old HEAD.
      } else if (previousEdited) {
        // An editor may have kept writing the previous extension as well.
      } else if (
        change.hadOriginal &&
        existsSync(oldPath) &&
        sameContents(oldPath, path.join(dir, 'before'))
      ) {
        // Publication never replaced this already correct original.
      } else if (change.hadOriginal) {
        const pending = path.join(dir, 'restore')
        saveCopy(pending, path.join(dir, 'before'))
        mkdirSync(path.dirname(oldPath), { recursive: true, mode: 0o700 })
        renameSync(pending, oldPath)
      } else rmSync(oldPath, { force: true })
      // Preserve an externally edited new extension alongside the restored old
      // path; never erase a file that no longer matches our published image.
      if (newPath !== oldPath && !laterEdit) rmSync(newPath, { force: true })
      if (existsSync(path.dirname(oldPath))) syncDirectory(path.dirname(oldPath))
    }
    // A committed file was fsynced before its marker committed. Leave later
    // external-editor changes intact; recovery must not overwrite those bytes.
    rmSync(dir, { recursive: true, force: true })
    db.prepare('DELETE FROM artifact_file_commits WHERE operation_id=?').run(name)
  }
  if (readdirSync(root).length === 0) rmSync(root, { recursive: true, force: true })
}

/** Task deletion must also erase private before-images from an interrupted edit. */
export function cleanupTaskWorkingCopies(dataDir: string, taskId: string): void {
  const root = workingCopyJournalDir(dataDir)
  if (!existsSync(root)) return
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name))
    .map((entry) => path.join(root, entry.name))
  forEachIsolatedSync(
    dirs,
    {
      pass: 'artifact-file-journal-cleanup',
      key: (dir) => path.basename(dir),
      isFatal: isStorageFatal
    },
    (dir) => {
      const read = readJournal(dir)
      if ('error' in read) {
        // Unreadable: it may hold this task's bytes. Delete it if it names the task,
        // otherwise set it aside so it never blocks another task's deletion.
        if (existsSync(dir) && readFileSync(path.join(dir, 'manifest.json')).includes(taskId))
          rmSync(dir, { recursive: true, force: true })
        else quarantineJournal(dataDir, dir, read.error)
        return
      }
      const change = read.change
      if (!change || change.taskId === taskId || change.previousTaskId === taskId)
        rmSync(dir, { recursive: true, force: true })
    }
  )
}
