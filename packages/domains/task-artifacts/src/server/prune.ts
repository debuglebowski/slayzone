import { BlobStore } from './blob-store'
import {
  artifactBlobReferenceSql,
  referencedArtifactBlobHashes,
  hasArtifactBlobLeases,
  requestArtifactBlobGc
} from './blob-pins'
import type { DbLike, TxnRunner } from './db'
import { getCurrentVersion, listVersions } from './resolve'
import type {
  ArtifactId,
  ArtifactVersion,
  ContentHash,
  PruneOptions,
  PruneReport
} from '../shared/types'

const inTransaction = (db: DbLike): boolean => {
  const state = db as DbLike & { inTransaction?: boolean; isTransaction?: boolean }
  return !!(state.inTransaction || state.isTransaction)
}

/**
 * Removes orphan blobs — files in the blob store with no version row pointing
 * to them. Safe to run any time. Caller must hold the txn boundary.
 */
export function gcOrphanBlobs(db: DbLike, blobStore: BlobStore): number {
  if (hasArtifactBlobLeases(db)) {
    requestArtifactBlobGc(db)
    return 0
  }
  // Never release a prior prune's rollback links from inside another mutation.
  const recorded = db
    .prepare(`SELECT hash FROM artifact_blobs WHERE hash NOT IN (${artifactBlobReferenceSql(db)})`)
    .all() as { hash: string }[]
  const referenced = referencedArtifactBlobHashes(db)
  const orphans = [
    ...new Set([
      ...recorded.map((row) => row.hash),
      ...blobStore
        .listAllHashes()
        .filter((hash) => /^[a-f0-9]{64}$/.test(hash) && !referenced.has(hash))
    ])
  ].map((hash) => ({ hash }))
  let deleted = 0
  try {
    for (const { hash } of orphans) blobStore.stageDelete(hash)
    for (const { hash } of orphans) {
      db.prepare('DELETE FROM artifact_blobs WHERE hash = ?').run(hash)
      if (blobStore.delete(hash as ContentHash)) deleted++
    }
  } catch (err) {
    for (const { hash } of orphans) blobStore.restoreDeleted(hash)
    throw err
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
  if (!inTransaction(db) && !hasArtifactBlobLeases(db))
    txn(() => {
      // TxnRunner can use BEGIN DEFERRED. Establish the writer lock before
      // releasing rollback links, including when another connection is active.
      db.prepare('UPDATE artifact_blobs SET hash=hash WHERE 0').run()
      blobStore.collectDeleted(referencedArtifactBlobHashes(db))
    })

  return { deletedVersions: toDelete.length, deletedBlobs, keptNamed }
}
