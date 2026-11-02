import type { Database } from 'better-sqlite3'
import { randomUUID, createHash } from 'node:crypto'
import {
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
import { isPathSafeId } from '@slayzone/platform/safe-path'
import { artifactFilePathIn, artifactsDirOf } from '@slayzone/task/server/artifact-paths'

interface FileChange {
  taskId: string
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
  const fd = openSync(file, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
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
    !isPathSafeId(value.taskId) ||
    !isPathSafeId(value.artifactId) ||
    typeof value.previousTitle !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.hadOriginal !== 'boolean' ||
    !Number.isSafeInteger(value.sequence)
  )
    throw new Error('Invalid artifact file journal')
  return value
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
    change.taskId,
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
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name))
    .map((entry) => ({ name: entry.name, change: manifest(path.join(root, entry.name)) }))
    .sort((a, b) => (b.change?.sequence ?? 0) - (a.change?.sequence ?? 0))
  for (const entry of entries) {
    const dir = path.join(root, entry.name),
      change = entry.change
    const committed = db
      .prepare('SELECT 1 FROM artifact_file_commits WHERE operation_id=?')
      .get(entry.name)
    if (change && !committed) {
      const oldPath = artifactFilePathIn(
        artifactsDirOf(dataDir),
        change.taskId,
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
    db.prepare('DELETE FROM artifact_file_commits WHERE operation_id=?').run(entry.name)
  }
  if (readdirSync(root).length === 0) rmSync(root, { recursive: true, force: true })
}

/** Task deletion must also erase private before-images from an interrupted edit. */
export function cleanupTaskWorkingCopies(dataDir: string, taskId: string): void {
  const root = workingCopyJournalDir(dataDir)
  if (!existsSync(root)) return
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue
    const dir = path.join(root, entry.name)
    const change = manifest(dir)
    if (!change || change.taskId === taskId) rmSync(dir, { recursive: true, force: true })
  }
}
