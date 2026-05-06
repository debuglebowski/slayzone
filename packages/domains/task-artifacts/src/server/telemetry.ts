import { BlobStore } from './blob-store'
import type { DbLike } from './db'
import type { ArtifactId, StorageStats } from '../shared/types'

/**
 * Aggregate disk usage from the blob store, grouped by artifact.
 * Useful for surfacing "this artifact has X versions taking Y MB" in UI
 * and as a heuristic for when to suggest pruning.
 */
export function getStorageStats(db: DbLike, _blobStore: BlobStore): StorageStats {
  const totalRow = db
    .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS s FROM artifact_blobs')
    .get() as { n: number; s: number }

  const perArtifactRows = db
    .prepare(
      `SELECT av.artifact_id AS artifact_id,
              COALESCE(SUM(b.size), 0) AS bytes,
              COUNT(av.id) AS versions
       FROM artifact_versions av
       LEFT JOIN artifact_blobs b ON b.hash = av.content_hash
       GROUP BY av.artifact_id`
    )
    .all() as { artifact_id: string; bytes: number; versions: number }[]

  return {
    totalBlobs: totalRow.n,
    totalBytes: totalRow.s,
    perArtifact: perArtifactRows.map((r) => ({
      artifact_id: r.artifact_id as ArtifactId,
      bytes: r.bytes,
      versions: r.versions,
    })),
  }
}
