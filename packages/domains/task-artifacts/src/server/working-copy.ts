import {
  readArtifactPreparationOwner,
  assertNoUnattributedArtifactPreparations,
  removeArtifactJournal
} from '@slayzone/content-erasure/server'
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
import type { PreparedArtifactPublicationFiles } from './artifact-publication-files'
import { hasArtifactBlobLeases, referencedArtifactBlobHashes } from './blob-pins'
import { artifactBlobPath } from '@slayzone/task/server/artifact-paths'
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

const activePublications = new Set<string>()
/** Register before preparation yields. Recovery/erasure may never adopt a live job. */
export function registerArtifactPublication(dataDir: string, jobId: string): () => void {
  const dir = path.join(workingCopyJournalDir(dataDir), jobId)
  if (activePublications.has(dir)) throw new Error('Artifact publication is already registered')
  activePublications.add(dir)
  return () => activePublications.delete(dir)
}

const preparationOwner = readArtifactPreparationOwner

/** Keep durable attribution until every body has durably disappeared, including claimed UUIDs. */
function removeJournal(dir: string): void {
  removeArtifactJournal(dir, (file) => rmSync(file, { recursive: true, force: true }))
}

function syncDirectory(dir: string): void {
  if (process.platform === 'win32') return
  const fd = openSync(dir, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
export const syncWorkingCopyDirectory = syncDirectory

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
  if (!existsSync(file)) {
    // Preparing jobs and cleanup claims have an owner even before a final manifest exists.
    let owner: ReturnType<typeof preparationOwner>
    try {
      owner = preparationOwner(dir)
    } catch {
      throw new StructuralFaultError('Unattributed artifact preparation owner')
    }
    if (!owner && readdirSync(dir).length)
      throw new StructuralFaultError('Unattributed artifact preparation')
    return null
  }
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

/** Bulk images and the publish copy are already durable. Only metadata/renames in this txn. */
export function publishPreparedWorkingCopy(
  db: Database,
  dataDir: string,
  prepared: PreparedArtifactPublicationFiles,
  change: Omit<FileChange, 'hadOriginal' | 'sequence'>
): void {
  const dir = prepared.directory
  if (
    dir !== path.join(workingCopyJournalDir(dataDir), prepared.jobId) ||
    !activePublications.has(dir)
  )
    throw new Error('Prepared artifact journal is not owned')
  const owner = preparationOwner(dir)
  if (!owner || owner.taskId !== change.taskId)
    throw new Error('Prepared artifact journal owner changed')
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
  const sequence = Number(
    db.prepare('INSERT INTO artifact_file_commits(operation_id) VALUES(?)').run(prepared.jobId)
      .lastInsertRowid
  )
  save(
    path.join(dir, 'manifest.tmp'),
    JSON.stringify({ ...change, hadOriginal: !!prepared.before, sequence })
  )
  renameSync(path.join(dir, 'manifest.tmp'), path.join(dir, 'manifest.json'))
  syncDirectory(dir)
  syncDirectory(workingCopyJournalDir(dataDir))
  mkdirSync(path.dirname(newPath), { recursive: true, mode: 0o700 })
  renameSync(path.join(dir, 'publish'), newPath)
  if (newPath !== oldPath) rmSync(oldPath, { force: true })
  syncDirectory(path.dirname(newPath))
}

/** Called only with the writer lock, after any enclosing transaction has ended. */
export function recoverWorkingCopies(
  db: Database,
  dataDir: string,
  options: { strict?: boolean } = {}
): void {
  const root = workingCopyJournalDir(dataDir)
  if (!existsSync(root)) {
    db.prepare('DELETE FROM artifact_file_commits').run()
    return
  }
  const entries: Array<{ name: string; change: FileChange | null }> = []
  const readReport = forEachIsolatedSync(
    readdirSync(root, { withFileTypes: true }).filter(
      (entry) => entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name)
    ),
    { pass: 'artifact-file-journal-read', key: (entry) => entry.name, isFatal: isStorageFatal },
    (entry) => {
      const dir = path.join(root, entry.name)
      if (activePublications.has(dir)) return
      const read = readJournal(dir)
      if ('error' in read) {
        // The unreadable journal alone is set aside; its quarantine entry is the record.
        quarantineJournal(dataDir, dir, read.error)
        db.prepare('DELETE FROM artifact_file_commits WHERE operation_id=?').run(entry.name)
      } else entries.push({ name: entry.name, change: read.change })
    }
  )
  entries.sort((a, b) => (b.change?.sequence ?? 0) - (a.change?.sequence ?? 0))
  const recoveryReport = forEachIsolatedSync(
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
  if (options.strict && (readReport.failed.length || recoveryReport.failed.length))
    throw new AggregateError(
      [...readReport.failed, ...recoveryReport.failed].map((entry) => entry.error),
      'Artifact journal recovery incomplete'
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
    const blobFile = path.join(dir, 'blob.json')
    if (existsSync(blobFile)) {
      const blob = JSON.parse(readFileSync(blobFile, 'utf8'))
      if (
        blob?.version !== 1 ||
        !/^[a-f0-9]{64}$/.test(blob.sha256) ||
        !Number.isSafeInteger(blob.size) ||
        blob.size < 0
      )
        throw new StructuralFaultError('Invalid artifact publication blob inventory')
      if (!referencedArtifactBlobHashes(db).has(blob.sha256)) {
        // Another live job/backup may still use an unreferenced immutable image.
        // Retain its attribution until the last pin drains; never forget these bytes.
        if (hasArtifactBlobLeases(db)) return
        const file = artifactBlobPath(dataDir, blob.sha256)
        rmSync(file, { force: true })
        if (existsSync(path.dirname(file))) syncDirectory(path.dirname(file))
      }
    }
    // A committed file was fsynced before its marker committed. Leave later
    // external-editor changes intact; recovery must not overwrite those bytes.
    removeJournal(dir)
    db.prepare('DELETE FROM artifact_file_commits WHERE operation_id=?').run(name)
  }
  if (readdirSync(root).length === 0) rmSync(root, { recursive: true, force: true })
}

/** Task deletion must also erase private before-images from an interrupted edit. */
export function cleanupTaskWorkingCopies(dataDir: string, taskId: string): void {
  assertNoUnattributedArtifactPreparations(dataDir)
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
      if (activePublications.has(dir))
        throw new Error('Artifact publication is still physically active')
      const read = readJournal(dir)
      if ('error' in read) {
        // Unreadable: it may hold this task's bytes. Delete it if it names the task,
        // otherwise set it aside so it never blocks another task's deletion.
        const header = ['manifest.json', 'owner.json'].find((name) =>
          existsSync(path.join(dir, name))
        )
        if (existsSync(dir) && header && readFileSync(path.join(dir, header)).includes(taskId))
          removeJournal(dir)
        else quarantineJournal(dataDir, dir, read.error)
        return
      }
      const change = read.change
      if (
        change
          ? change.taskId === taskId || change.previousTaskId === taskId
          : preparationOwner(dir)?.taskId === taskId
      )
        removeJournal(dir)
    }
  )
}
