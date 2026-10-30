/**
 * The hub's reader for files attached to chat messages: the terminal domain
 * builds Claude's image / document blocks from these bytes at write time, but
 * may not import the artifact store (it sits above terminal), so the
 * composition root hands it this reader.
 *
 * A sealed message carries the content hash of the version that was attached;
 * blobs are content-addressed and shared across tasks, so the hash is honoured
 * only when it is a version of that same artifact.
 *
 * @module hub/chat-attachment-reader
 */
import { readFile } from 'node:fs/promises'
import type { SlayzoneDb } from '@slayzone/platform'
import { BlobStore, createArtifactStore } from '@slayzone/task-artifacts/server'
import type { ChatAttachmentReader } from '@slayzone/terminal/server'

export function createChatAttachmentReader(db: SlayzoneDb, dataRoot: string): ChatAttachmentReader {
  const blobs = new BlobStore(dataRoot)
  return {
    read: async ({ artifactId, contentHash }) => {
      const row = await db.get<{ hash: string | null }>(
        contentHash
          ? `SELECT content_hash AS hash FROM artifact_versions WHERE artifact_id = ? AND content_hash = ? LIMIT 1`
          : `SELECT v.content_hash AS hash FROM task_artifacts a
               LEFT JOIN artifact_versions v ON v.id = a.current_version_id WHERE a.id = ?`,
        contentHash ? [artifactId, contentHash] : [artifactId]
      )
      if (row?.hash) return readFile(blobs.blobPath(row.hash))
      // No version history (a row from before it existed): its working file.
      const path = await createArtifactStore(dataRoot).getArtifactPath(db, artifactId)
      if (!path) throw new Error(`artifact ${artifactId} not found`)
      return readFile(path)
    }
  }
}
