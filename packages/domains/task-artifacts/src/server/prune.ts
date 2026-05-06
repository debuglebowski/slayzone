import { BlobStore } from './blob-store'
import type { DbLike, TxnRunner } from './db'
import { getCurrentVersion, listVersions } from './resolve'
import type { ArtifactId, ArtifactVersion, ContentHash, PruneOptions, PruneReport } from '../shared/types'

/**
 * Removes orphan blobs — files in the blob store with no version row pointing
 * to them. Safe to run any time. Caller must hold the txn boundary.
 */
export function gcOrphanBlobs(db: DbLike, blobStore: BlobStore): number {
  const orphans = db
    .prepare(
      `SELECT hash FROM artifact_blobs
       WHERE hash NOT IN (SELECT DISTINCT content_hash FROM artifact_versions)`
    )
    .all() as { hash: string }[]
  let deleted = 0
  for (const { hash } of orphans) {
    db.prepare('DELETE FROM artifact_blobs WHERE hash = ?').run(hash)
    if (blobStore.delete(hash as ContentHash)) deleted++
  }
  return deleted
}

/**
 * Drop versions older than `keepLast`. Named versions are protected by default
 * (`keepNamed: true`). Then GCs any blobs that no version row references.
 */
export function pruneVersions(
  db: DbLike,
  txn: TxnRunner,
  blobStore: BlobStore,
  artifactId: ArtifactId | string,
  opts: PruneOptions = {}
): PruneReport {
  const keepLast = opts.keepLast ?? 0
  const keepNamed = opts.keepNamed ?? true
  const keepCurrent = opts.keepCurrent ?? true
  const dryRun = opts.dryRun ?? false

  const allVersions = listVersions(db, artifactId, { limit: 1_000_000 })
  const currentId = keepCurrent ? getCurrentVersion(db, artifactId)?.id : undefined

  const toDelete: ArtifactVersion[] = []
  let keptNamed = 0

  for (let i = 0; i < allVersions.length; i++) {
    const v = allVersions[i]
    const isRecent = i < keepLast
    const isNamed = v.name !== null
    if (isRecent) continue
    if (currentId && v.id === currentId) continue
    if (keepNamed && isNamed) {
      keptNamed++
      continue
    }
    toDelete.push(v)
  }

  if (dryRun) {
    return { deletedVersions: toDelete.length, deletedBlobs: 0, keptNamed }
  }

  let deletedBlobs = 0
  txn(() => {
    for (const v of toDelete) {
      db.prepare('DELETE FROM artifact_versions WHERE id = ?').run(v.id)
    }
    deletedBlobs = gcOrphanBlobs(db, blobStore)
  })

  return { deletedVersions: toDelete.length, deletedBlobs, keptNamed }
}
