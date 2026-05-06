import { BlobStore } from './blob-store'
import type { DbLike } from './db'
import { parseRows } from './parse'
import type { ArtifactId, IntegrityIssue, IntegrityReport } from '../shared/types'

export interface IntegrityScope {
  artifactId?: ArtifactId | string
}

/**
 * Verifies that every version row has a backing blob and the blob's bytes
 * actually hash to the recorded `content_hash` and report the recorded
 * `size`. Use to catch FS corruption, partial restores, manual rm.
 *
 * Read-only. Returns a list of issues — caller decides how to remediate.
 */
export function checkIntegrity(
  db: DbLike,
  blobStore: BlobStore,
  scope: IntegrityScope = {}
): IntegrityReport {
  const sql = scope.artifactId
    ? 'SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY artifact_id, version_num'
    : 'SELECT * FROM artifact_versions ORDER BY artifact_id, version_num'
  const rows = scope.artifactId
    ? db.prepare(sql).all(scope.artifactId)
    : db.prepare(sql).all()
  const versions = parseRows(rows)

  const issues: IntegrityIssue[] = []
  for (const v of versions) {
    if (!blobStore.has(v.content_hash)) {
      issues.push({
        artifact_id: v.artifact_id,
        version_id: v.id,
        version_num: v.version_num,
        content_hash: v.content_hash,
        problem: 'blob_missing',
      })
      continue
    }
    if (blobStore.size(v.content_hash) !== v.size) {
      issues.push({
        artifact_id: v.artifact_id,
        version_id: v.id,
        version_num: v.version_num,
        content_hash: v.content_hash,
        problem: 'size_mismatch',
      })
      continue
    }
    if (!blobStore.verify(v.content_hash)) {
      issues.push({
        artifact_id: v.artifact_id,
        version_id: v.id,
        version_num: v.version_num,
        content_hash: v.content_hash,
        problem: 'hash_mismatch',
      })
    }
  }

  return { checked: versions.length, issues }
}
