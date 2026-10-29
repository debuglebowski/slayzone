import { useMemo } from 'react'
import type { ArtifactUploader } from '@slayzone/editor/hooks'
import { useTRPCClient } from './trpc'

/**
 * This feature's implementation of the editor's `ArtifactUploader` contract
 * (paste/drop image upload into editors). The composing app registers it once
 * via the editor's `registerArtifactUploader` before its first render — the
 * editor is mounted by task + task-terminals, not by this package, so the app
 * (which depends on all three) is the one place that can bind it.
 */
export function useArtifactUploader(): ArtifactUploader {
  const trpcClient = useTRPCClient()
  return useMemo(
    (): ArtifactUploader => ({
      getOrCreateFolder: async (taskId, name) => {
        const folder = await trpcClient.artifacts.foldersGetOrCreateByName.mutate({ taskId, name })
        return folder?.id ?? null
      },
      uploadBlob: async ({ taskId, title, bytes, folderId }) => {
        const created = await trpcClient.artifacts.uploadBlob.mutate({
          taskId,
          title,
          bytes,
          folderId
        })
        // Narrowed to the contract's public shape — the procedure returns the
        // full TaskArtifact row, but upload callers only ever consume {id, title}.
        return created ? { id: created.id, title: created.title } : null
      },
      getFilePath: (artifactId) => trpcClient.artifacts.getFilePath.query({ id: artifactId })
    }),
    [trpcClient]
  )
}
