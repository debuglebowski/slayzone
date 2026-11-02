import type { Database } from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import {
  constants,
  createReadStream,
  existsSync,
  linkSync,
  mkdirSync,
  promises as fsAsync,
  rmSync,
  statSync
} from 'node:fs'
import { join } from 'node:path'
import {
  BlobStore,
  createArtifactStore,
  ensureWorkingCopySchema,
  recoverWorkingCopies,
  referencedArtifactBlobHashes
} from '@slayzone/task-artifacts/storage'
import type { ChatStorage } from './storage'

export interface ArtifactBackupFile {
  path: string
  source: string
  hash: string
  size: number
}

type ArtifactRow = Record<string, unknown> & {
  id: string
  task_id: string
  title: string
  current_version_id: string | null
}
const artifactRows = (db: Database): ArtifactRow[] =>
  db
    .prepare(`
  SELECT a.*,o.conversation_id AS snapshot_owner,v.content_hash AS snapshot_current_hash,v.size AS snapshot_current_size
  FROM task_artifacts a JOIN artifact_owners o ON o.id=a.id AND o.kind='artifact'
  LEFT JOIN artifact_versions v ON v.id=a.current_version_id ORDER BY a.id
`)
    .all() as ArtifactRow[]
const hasArtifacts = (db: Database): boolean =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifact_owners'").get()

/**
 * Capture mutable originals before starting the asynchronous SQLite backup.
 * A short writer lock pins each original inode with its row proof; immutable
 * copies and streaming hashes are prepared after releasing that lock. Snapshot proof is checked again against the completed DB
 * backup; a concurrent artifact edit requires a new backup attempt rather than
 * silently associating newer working bytes with an older database.
 *
 * Blob copies are private to this backup. No live versions or blob rows change.
 */
async function captureWorkingFiles(store: ChatStorage, stagingDir: string) {
  const snapshots = new Map<string, { proof: string; file: ArtifactBackupFile | null }>()
  const artifacts = createArtifactStore(store.dir)
  const originals: Array<{ id: string; linked: string; sealed: string; stat: string }> = []
  const fileProof = (file: string) => {
    const stat = statSync(file, { bigint: true })
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
  }
  mkdirSync(stagingDir, { recursive: true, mode: 0o700 })
  try {
    store.compose((raw) => {
      if (raw.inTransaction)
        throw new Error('Artifact backup capture requires an independent snapshot boundary')
      raw
        .transaction(() => {
          if (!hasArtifacts(raw)) return
          ensureWorkingCopySchema(raw)
          recoverWorkingCopies(raw, store.dir)
          // A rolled-back prune can leave its only historical copy quarantined.
          // This independent writer transaction observes committed references.
          new BlobStore(store.dir).restoreReferenced(referencedArtifactBlobHashes(raw))
          for (const row of artifactRows(raw)) {
            const path = artifacts.getArtifactFilePath(row.task_id, row.id, row.title)
            if (existsSync(path)) {
              const token = randomUUID(),
                linked = join(stagingDir, `${token}.link`),
                sealed = join(stagingDir, token)
              // Both paths are under this computer namespace. A hard link pins the
              // old inode across application atomic replaces and task deletion.
              linkSync(path, linked)
              originals.push({ id: row.id, linked, sealed, stat: '' })
            } else if (!row.current_version_id)
              throw new Error(`Artifact has no recoverable working original: ${row.id}`)
            snapshots.set(row.id, { proof: JSON.stringify(row), file: null })
          }
          for (const original of originals) original.stat = fileProof(original.linked)
        })
        .immediate()
    })
    for (const original of originals) {
      // CoW where supported, otherwise an asynchronous kernel copy. Never hold
      // SQLite's writer lock while copying or hashing potentially large files.
      await fsAsync.copyFile(original.linked, original.sealed, constants.COPYFILE_FICLONE)
      if (fileProof(original.linked) !== original.stat)
        throw new Error('Working original changed during backup capture; retry backup')
      const fd = await fsAsync.open(original.sealed, 'r')
      try {
        await fd.sync()
      } finally {
        await fd.close()
      }
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(original.sealed)) hash.update(chunk)
      const contentHash = hash.digest('hex'),
        size = (await fsAsync.stat(original.sealed)).size
      snapshots.get(original.id)!.file = {
        path: `blobs/${contentHash.slice(0, 2)}/${contentHash.slice(2)}`,
        source: original.sealed,
        hash: contentHash,
        size
      }
    }
    for (const original of originals) await fsAsync.rm(original.linked)
  } catch (err) {
    rmSync(stagingDir, { recursive: true, force: true })
    throw err
  }
  return {
    apply(snapshot: Database): ArtifactBackupFile[] {
      if (!hasArtifacts(snapshot)) return []
      const files = new Map<string, ArtifactBackupFile>()
      snapshot.transaction(() => {
        snapshot.exec(`CREATE TABLE artifact_working_files(
          artifact_id TEXT PRIMARY KEY REFERENCES task_artifacts(id) ON DELETE CASCADE,
          content_hash TEXT NOT NULL,size INTEGER NOT NULL
        )`)
        const insert = snapshot.prepare(
          'INSERT INTO artifact_working_files(artifact_id,content_hash,size) VALUES(?,?,?)'
        )
        for (const row of artifactRows(snapshot)) {
          const captured = snapshots.get(row.id)
          if (!captured || captured.proof !== JSON.stringify(row))
            throw new Error('Artifacts changed during backup snapshot; retry backup')
          if (!captured.file) continue
          insert.run(row.id, captured.file.hash, captured.file.size)
          files.set(captured.file.path, captured.file)
        }
      })()
      return [...files.values()]
    },
    dispose(): void {
      rmSync(stagingDir, { recursive: true, force: true })
    }
  }
}

const captures = new WeakMap<ChatStorage, Promise<unknown>>()
/** Serialize only original capture; independent database/blob backups may overlap. */
export function captureArtifactWorkingFiles(store: ChatStorage, stagingDir: string) {
  const previous = captures.get(store) ?? Promise.resolve()
  const work = previous.catch(() => undefined).then(() => captureWorkingFiles(store, stagingDir))
  captures.set(store, work)
  return work.finally(() => {
    if (captures.get(store) === work) captures.delete(store)
  })
}
