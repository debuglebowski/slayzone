import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync
} from 'node:fs'
import path from 'node:path'
import type { SlayzoneDb } from '@slayzone/platform'
import { containedPath } from '@slayzone/platform/safe-path'
import { artifactsDirOf, artifactTaskDir } from '@slayzone/task/server/artifact-paths'
import { BlobStore } from './blob-store'

/**
 * The `copy-files` step of a move between hubs (slice 3c): the artifacts' bytes —
 * every version's blob and each task's working copies — copied from the hub the tasks
 * leave to the hub they go to, in chunks the app relays, each file checked by its
 * sha-256 before it takes its place. Resumable: a file is written from the offset its
 * staging copy reached; one the target already holds (same hash) is not sent.
 *
 * The rows (`artifact_versions` naming each blob) arrived in `import`, so a blob is
 * referenced — kept by the blob GC — the moment it lands.
 */

/**
 * One file a move copies: a version blob by hash, a working copy by its path, or a
 * moved project's icon (`<projectId>.<ext>` in `project-icons/`).
 */
export type MoveFileRef =
  | { kind: 'blob'; hash: string }
  | { kind: 'file'; taskId: string; path: string }
  | { kind: 'project-icon'; projectId: string; name: string }

export interface MoveFileEntry {
  ref: MoveFileRef
  size: number
  hash: string
}

/** The biggest chunk a read answers (base64 over the socket). */
export const MOVE_FILE_CHUNK_BYTES = 512 * 1024

/** A move's file step asked of a hub that does not hold the move in that role. */
export class MoveFilesRefusedError extends Error {
  override name = 'MoveFilesRefusedError'
}

const LOCKING = "('running', 'paused', 'failed')"

/** The tasks of an unfinished move in `direction`, and its project when it moves one. */
async function moveScope(
  db: SlayzoneDb,
  moveId: string,
  direction: 'out' | 'in'
): Promise<{ taskIds: string[]; projectId: string | null }> {
  const move = await db.get<{ id: string; scope: string; project_id: string | null }>(
    `SELECT id, scope, project_id FROM task_moves
      WHERE id = ? AND direction = ? AND status IN ${LOCKING}`,
    [moveId, direction]
  )
  if (!move)
    throw new MoveFilesRefusedError(
      `No unfinished move ${moveId} ${direction === 'out' ? 'leaving' : 'arriving at'} this hub`
    )
  const taskIds = (
    await db.all<{ task_id: string }>('SELECT task_id FROM task_move_tasks WHERE move_id = ?', [
      moveId
    ])
  ).map((r) => r.task_id)
  return { taskIds, projectId: move.scope === 'project' ? move.project_id : null }
}

/** Refuses a ref that is not this move's (a task's file of another task, another project's icon). */
function assertOwnRef(
  scope: { taskIds: string[]; projectId: string | null },
  ref: MoveFileRef
): void {
  if (ref.kind === 'file' && !scope.taskIds.includes(ref.taskId))
    throw new MoveFilesRefusedError('Not a file of this move')
  if (
    ref.kind === 'project-icon' &&
    (ref.projectId !== scope.projectId ||
      !ref.name.startsWith(`${ref.projectId}.`) ||
      /[\\/]/.test(ref.name))
  )
    throw new MoveFilesRefusedError('Not an icon of this move')
}

/** A hub's project icons (`projectIconsDirOf` in @slayzone/projects, not a dependency here). */
const iconsDirOf = (dataRoot: string): string => path.join(dataRoot, 'project-icons')

const sha256File = (file: string): string =>
  createHash('sha256').update(readFileSync(file)).digest('hex')

/** Every file under `dir` (relative paths), skipping the store's own dot-entries. */
function walk(dir: string, prefix = ''): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel))
    else if (entry.isFile()) out.push(rel)
  }
  return out
}

/** Source: every file the move's tasks own here. */
export async function moveFilesManifest(
  db: SlayzoneDb,
  dataRoot: string,
  moveId: string
): Promise<MoveFileEntry[]> {
  const { taskIds, projectId } = await moveScope(db, moveId, 'out')
  const icons: MoveFileEntry[] = []
  if (projectId) {
    const dir = iconsDirOf(dataRoot)
    const names = existsSync(dir)
      ? readdirSync(dir).filter((n) => n.startsWith(`${projectId}.`))
      : []
    for (const name of names) {
      const file = containedPath(dir, name)
      icons.push({
        ref: { kind: 'project-icon', projectId, name },
        size: statSync(file).size,
        hash: sha256File(file)
      })
    }
  }
  if (taskIds.length === 0) return icons
  const blobs = new BlobStore(dataRoot)
  const ph = taskIds.map(() => '?').join(', ')
  const hashes = await db.all<{ content_hash: string }>(
    `SELECT DISTINCT v.content_hash FROM artifact_versions v
       JOIN task_artifacts a ON a.id = v.artifact_id WHERE a.task_id IN (${ph})`,
    taskIds
  )
  const out: MoveFileEntry[] = [...icons]
  for (const { content_hash: hash } of hashes) {
    if (!blobs.has(hash)) continue
    out.push({ ref: { kind: 'blob', hash }, size: blobs.size(hash), hash })
  }
  const artifactsDir = artifactsDirOf(dataRoot)
  for (const taskId of taskIds) {
    const dir = artifactTaskDir(artifactsDir, taskId)
    for (const rel of walk(dir)) {
      const file = containedPath(dir, rel)
      out.push({
        ref: { kind: 'file', taskId, path: rel },
        size: statSync(file).size,
        hash: sha256File(file)
      })
    }
  }
  return out
}

function sourcePath(dataRoot: string, ref: MoveFileRef): string {
  if (ref.kind === 'blob') return new BlobStore(dataRoot).blobPath(ref.hash)
  if (ref.kind === 'project-icon') return containedPath(iconsDirOf(dataRoot), ref.name)
  return containedPath(artifactTaskDir(artifactsDirOf(dataRoot), ref.taskId), ref.path)
}

/** Source: `length` bytes of a manifest file from `offset`, base64. */
export async function readMoveFile(
  db: SlayzoneDb,
  dataRoot: string,
  input: { moveId: string; ref: MoveFileRef; offset: number; length: number }
): Promise<{ data: string; eof: boolean }> {
  const scope = await moveScope(db, input.moveId, 'out')
  const { taskIds } = scope
  assertOwnRef(scope, input.ref)
  if (input.ref.kind === 'blob') {
    if (taskIds.length === 0) throw new MoveFilesRefusedError('Not a blob of this move')
    const ph = taskIds.map(() => '?').join(', ')
    const owned = await db.get(
      `SELECT 1 FROM artifact_versions v JOIN task_artifacts a ON a.id = v.artifact_id
        WHERE v.content_hash = ? AND a.task_id IN (${ph}) LIMIT 1`,
      [input.ref.hash, ...taskIds]
    )
    if (!owned) throw new MoveFilesRefusedError('Not a blob of this move')
  }
  const file = sourcePath(dataRoot, input.ref)
  const length = Math.min(input.length, MOVE_FILE_CHUNK_BYTES)
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(length)
    const read = readSync(fd, buf, 0, length, input.offset)
    return {
      data: buf.subarray(0, read).toString('base64'),
      eof: input.offset + read >= statSync(file).size
    }
  } finally {
    closeSync(fd)
  }
}

const stagingDir = (dataRoot: string, moveId: string): string =>
  containedPath(dataRoot, '.task-move-staging', moveId)
const stagingName = (ref: MoveFileRef): string =>
  createHash('sha256')
    .update(
      ref.kind === 'blob'
        ? `blob:${ref.hash}`
        : ref.kind === 'project-icon'
          ? `icon:${ref.projectId}/${ref.name}`
          : `file:${ref.taskId}/${ref.path}`
    )
    .digest('hex')

function targetPath(dataRoot: string, ref: MoveFileRef): string {
  return sourcePath(dataRoot, ref)
}

/**
 * Target: of `entries`, the ones still to copy (absent here, or different), each
 * with the offset its staging copy reached (a resumed copy goes on from there).
 */
export async function missingMoveFiles(
  db: SlayzoneDb,
  dataRoot: string,
  input: { moveId: string; entries: MoveFileEntry[] }
): Promise<Array<MoveFileEntry & { offset: number }>> {
  const scope = await moveScope(db, input.moveId, 'in')
  const blobs = new BlobStore(dataRoot)
  const out: Array<MoveFileEntry & { offset: number }> = []
  for (const entry of input.entries) {
    assertOwnRef(scope, entry.ref)
    const present =
      entry.ref.kind === 'blob'
        ? blobs.has(entry.ref.hash)
        : existsSync(targetPath(dataRoot, entry.ref)) &&
          sha256File(targetPath(dataRoot, entry.ref)) === entry.hash
    if (present) continue
    const staged = path.join(stagingDir(dataRoot, input.moveId), stagingName(entry.ref))
    out.push({ ...entry, offset: existsSync(staged) ? statSync(staged).size : 0 })
  }
  return out
}

/**
 * Target: write a chunk at `offset` of a file's staging copy. The chunk carrying the
 * end (`complete`) checks the whole copy against its hash and puts it in place: a
 * blob into the blob store, a working copy into its task's folder, a project's icon
 * into `project-icons/`. A chunk at an
 * offset the staging copy has not reached is refused (the app asks `missing` again).
 */
export async function writeMoveFile(
  db: SlayzoneDb,
  dataRoot: string,
  input: {
    moveId: string
    ref: MoveFileRef
    offset: number
    data: string
    complete?: { size: number; hash: string }
  }
): Promise<{ written: number }> {
  assertOwnRef(await moveScope(db, input.moveId, 'in'), input.ref)
  const dir = stagingDir(dataRoot, input.moveId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const staged = path.join(dir, stagingName(input.ref))
  const have = existsSync(staged) ? statSync(staged).size : 0
  if (input.offset > have)
    throw new MoveFilesRefusedError(`Chunk at ${input.offset}, staging copy holds ${have} bytes`)
  const bytes = Buffer.from(input.data, 'base64')
  const fd = openSync(staged, input.offset === 0 ? 'w' : 'r+')
  try {
    writeSync(fd, bytes, 0, bytes.length, input.offset)
  } finally {
    closeSync(fd)
  }
  const written = input.offset + bytes.length
  if (!input.complete) return { written }

  const content = readFileSync(staged)
  const hash = createHash('sha256').update(content).digest('hex')
  if (content.length !== input.complete.size || hash !== input.complete.hash) {
    rmSync(staged, { force: true })
    throw new MoveFilesRefusedError('The copy does not match its source (size or hash)')
  }
  if (input.ref.kind === 'blob') {
    if (hash !== input.ref.hash) throw new MoveFilesRefusedError('Blob hash mismatch')
    new BlobStore(dataRoot).write(content)
    await db.run('INSERT OR IGNORE INTO artifact_blobs (hash, size) VALUES (?, ?)', [
      hash,
      content.length
    ])
    rmSync(staged, { force: true })
  } else {
    const dest = targetPath(dataRoot, input.ref)
    mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 })
    renameSync(staged, dest)
  }
  return { written }
}

/** Target: drop a move's staging copies (the move is committed or canceled). */
export function clearMoveStaging(dataRoot: string, moveId: string): void {
  rmSync(stagingDir(dataRoot, moveId), { recursive: true, force: true })
}
