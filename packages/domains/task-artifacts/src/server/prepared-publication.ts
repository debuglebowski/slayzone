import { wrapVersionError } from './artifact-store-txns'
/** Canonical-worker publication: bulk I/O before the short metadata transaction. */
import type { Database } from 'better-sqlite3'
import { constants, existsSync, lstatSync, renameSync, type BigIntStats } from 'node:fs'
import { chmod, copyFile, lstat, mkdir } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { uniqueName } from '@slayzone/file-editor/shared'
import { artifactFilePathIn, artifactsDirOf } from '@slayzone/task/server/artifact-paths'
import type { AuthorContext, ContentHash, VersionRef } from '../shared'
import {
  withPublicationFile,
  type PreparedArtifactPublicationFiles
} from './artifact-publication-files'
import { BlobStore } from './blob-store'
import { parseArtifact } from './artifact-store'
import { betterSqliteTxn } from './db'
import { getCurrentVersion } from './resolve'
import { createVersionFromBlob, mutateVersionFromBlob, saveCurrentFromBlob } from './mutations'
import { publishPreparedWorkingCopy, syncWorkingCopyDirectory } from './working-copy'

export type PreparedArtifactMutation =
  | {
      method: 'uploadArtifactBlob'
      artifactId: string
      taskId: string
      title: string
      folderId?: string | null
    }
  | {
      method: 'writeArtifactContent'
      artifactId: string
      taskId: string
      title: string
      mutateCurrent?: boolean
      mutateRef?: VersionRef
      author?: AuthorContext
    }

export async function syncPublicationDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  await withPublicationFile(
    path,
    'r',
    () => undefined,
    (file) => file.sync()
  )
}
async function durableCopy(source: string, target: string): Promise<void> {
  await copyFile(source, target, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL)
  await chmod(target, 0o600)
  await withPublicationFile(
    target,
    'r+',
    () => undefined,
    (file) => file.sync()
  )
}
async function validBlob(path: string, hash: string, size: number): Promise<boolean> {
  try {
    const metadata = await lstat(path)
    if (!metadata.isFile() || metadata.size !== size) return false
    return await withPublicationFile(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      () => undefined,
      async (file) => {
        const digest = createHash('sha256'),
          buffer = Buffer.allocUnsafe(256 * 1024)
        let total = 0
        for (;;) {
          const { bytesRead } = await file.read(
            buffer,
            0,
            Math.min(buffer.length, size - total + 1),
            null
          )
          if (!bytesRead) break
          total += bytesRead
          if (total > size) return false
          digest.update(buffer.subarray(0, bytesRead))
        }
        return total === size && digest.digest('hex') === hash
      }
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** All intermediate bodies stay in the attributed journal, never blobs/.tmp. */
export async function prepareArtifactPublicationOutputs(
  dataDir: string,
  files: PreparedArtifactPublicationFiles,
  check: () => void
): Promise<void> {
  check()
  await durableCopy(files.after.path, join(files.directory, 'publish'))
  check()
  const final = new BlobStore(dataDir).blobPath(files.after.sha256)
  await writeArtifactPublicationBlobInventory(files, check)
  if (!(await validBlob(final, files.after.sha256, files.after.size))) {
    check()
    await mkdir(dirname(final), { recursive: true, mode: 0o700 })
    check()
    const pending = join(files.directory, 'blob')
    await durableCopy(files.after.path, pending)
    check()
  }
  await syncPublicationDirectory(dirname(final))
  check()
  await syncPublicationDirectory(join(dataDir, 'blobs'))
  check()
  await syncPublicationDirectory(files.directory)
  check()
  await syncPublicationDirectory(dataDir)
  check()
}

/** Shared preparation attribution, including immutable chat attachment outputs. */
export async function writeArtifactPublicationBlobInventory(
  files: PreparedArtifactPublicationFiles,
  check: () => void
): Promise<void> {
  await withPublicationFile(join(files.directory, 'blob.json'), 'wx', check, async (file) => {
    await file.writeFile(
      JSON.stringify({ version: 1, sha256: files.after.sha256, size: files.after.size })
    )
    await file.sync()
  })
  await syncPublicationDirectory(files.directory)
  check()
}

/** Metadata-only snapshot check; never hash/read a whole previous working file in a txn. */
export function assertPreparedArtifactPrevious(
  dataDir: string,
  files: PreparedArtifactPublicationFiles,
  mutation: PreparedArtifactMutation
): void {
  const path = artifactFilePathIn(
    artifactsDirOf(dataDir),
    mutation.taskId,
    mutation.artifactId,
    mutation.title
  )
  let current: BigIntStats | undefined
  try {
    current = lstatSync(path, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const before = files.before?.sourceSnapshot
  if (
    before
      ? !current?.isFile() ||
        String(current.dev) !== before.dev ||
        String(current.ino) !== before.ino ||
        Number(current.size) !== before.size ||
        String(current.mtimeNs) !== before.mtimeNs ||
        String(current.ctimeNs) !== before.ctimeNs
      : !!current
  )
    throw new Error('Publication previous image changed before commit')
}

/** Caller owns one outer SQLite txn including receipt/outbox. No awaits or bulk copies. */
export function commitPreparedArtifactPublication(
  db: Database,
  dataDir: string,
  files: PreparedArtifactPublicationFiles,
  mutation: PreparedArtifactMutation
) {
  return wrapVersionError(() => {
    assertPreparedArtifactPrevious(dataDir, files, mutation)
    const pending = join(files.directory, 'blob')
    if (existsSync(pending)) {
      const final = new BlobStore(dataDir).blobPath(files.after.sha256)
      renameSync(pending, final)
      syncWorkingCopyDirectory(dirname(final))
      syncWorkingCopyDirectory(join(dataDir, 'blobs'))
    }
    let title = mutation.title
    if (mutation.method === 'uploadArtifactBlob') {
      const folder = mutation.folderId ?? null
      const siblings = db
        .prepare('SELECT title FROM task_artifacts WHERE task_id=? AND folder_id IS ?')
        .all(mutation.taskId, folder) as { title: string }[]
      title = uniqueName(title, new Set(siblings.map((row) => row.title)))
      const max = db
        .prepare('SELECT MAX("order") m FROM task_artifacts WHERE task_id=? AND folder_id IS ?')
        .get(mutation.taskId, folder) as { m: number | null }
      db.prepare(
        'INSERT INTO task_artifacts(id,task_id,folder_id,title,"order") VALUES(?,?,?,?,?)'
      ).run(mutation.artifactId, mutation.taskId, folder, title, (max.m ?? -1) + 1)
    }
    const blob = { hash: files.after.sha256 as ContentHash, size: files.after.size },
      txn = betterSqliteTxn(db)
    const author =
      mutation.method === 'writeArtifactContent'
        ? (mutation.author ?? { type: 'user' as const, id: null })
        : { type: 'user' as const, id: null }
    const args = { artifactId: mutation.artifactId, author }
    const version =
      mutation.method === 'writeArtifactContent' && mutation.mutateRef !== undefined
        ? mutateVersionFromBlob(db, txn, blob, { ...args, ref: mutation.mutateRef })
        : mutation.method === 'writeArtifactContent' && mutation.mutateCurrent
          ? saveCurrentFromBlob(db, txn, blob, args)
          : createVersionFromBlob(db, txn, blob, args)
    if (getCurrentVersion(db, mutation.artifactId)?.id === version.id)
      publishPreparedWorkingCopy(db, dataDir, files, {
        taskId: mutation.taskId,
        artifactId: mutation.artifactId,
        previousTitle: mutation.title,
        title
      })
    if (mutation.method === 'writeArtifactContent')
      db.prepare('UPDATE task_artifacts SET updated_at=? WHERE id=?').run(
        new Date().toISOString(),
        mutation.artifactId
      )
    const artifact = parseArtifact(
      db.prepare('SELECT * FROM task_artifacts WHERE id=?').get(mutation.artifactId) as
        | Record<string, unknown>
        | undefined
    )
    return mutation.method === 'uploadArtifactBlob'
      ? ({ method: mutation.method, result: artifact } as const)
      : ({ method: mutation.method, result: { artifact, version } } as const)
  })
}
export const newPublicationArtifactId = randomUUID
