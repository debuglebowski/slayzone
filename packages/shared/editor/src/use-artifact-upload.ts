import { useCallback, useEffect, useRef } from 'react'
import { useTRPCClient } from '@slayzone/transport/client'

export interface ArtifactRef {
  id: string
  title: string
}

export interface UseArtifactUploadReturn {
  uploadFiles: (files: File[]) => Promise<ArtifactRef[]>
  getFilePath: (artifactId: string) => Promise<string | null>
}

function tsSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function extFromMime(mime: string): string {
  if (!mime) return ''
  if (mime === 'image/jpeg') return '.jpg'
  if (mime === 'image/svg+xml') return '.svg'
  const m = mime.match(/^image\/([a-z0-9+\-.]+)$/i)
  return m ? `.${m[1]}` : ''
}

export interface UseArtifactUploadOptions {
  folderName?: string
}

// Routes through tRPC's `artifacts.*` procedures — NOT a `window`-global
// `api.artifacts` / `api.artifactFolders` reach-through, which does not exist
// in the `ElectronAPI` contract at all (@slayzone/types' `api.ts`) and was an
// unguarded cast that slipped past `scripts/check-renderer-window-api.sh` (it
// only scanned `packages/apps/app/src/renderer` + `packages/domains/*/src/
// client`, not `packages/shared/*/src` — extended alongside this fix). It
// threw on paste/drop an image on every host but the Electron app, since only
// the Electron preload ever defined those namespaces.
export function useArtifactUpload(
  taskId: string | null | undefined,
  options?: UseArtifactUploadOptions
): UseArtifactUploadReturn {
  const trpcClient = useTRPCClient()
  const taskIdRef = useRef(taskId)
  useEffect(() => {
    taskIdRef.current = taskId
  })
  const folderNameRef = useRef(options?.folderName)
  useEffect(() => {
    folderNameRef.current = options?.folderName
  })

  const uploadFiles = useCallback(
    async (files: File[]): Promise<ArtifactRef[]> => {
      const tid = taskIdRef.current
      if (!tid) return []
      let folderId: string | null = null
      const folderName = folderNameRef.current
      if (folderName) {
        const folder = await trpcClient.artifacts.foldersGetOrCreateByName.mutate({
          taskId: tid,
          name: folderName
        })
        folderId = folder?.id ?? null
      }
      const results = await Promise.all(
        files.map(async (file): Promise<ArtifactRef | null> => {
          const buf = await file.arrayBuffer()
          const bytes = new Uint8Array(buf)
          const baseTitle =
            file.name && file.name.length > 0
              ? file.name
              : `pasted-${tsSlug()}${extFromMime(file.type)}`
          const created = await trpcClient.artifacts.uploadBlob.mutate({
            taskId: tid,
            title: baseTitle,
            bytes,
            folderId
          })
          // Narrowed to this hook's own public shape — the tRPC procedure
          // actually returns the full TaskArtifact row, but callers of this
          // hook only ever consumed {id, title}.
          return created ? { id: created.id, title: created.title } : null
        })
      )
      return results.filter((a): a is ArtifactRef => a !== null)
    },
    [trpcClient]
  )

  const getFilePath = useCallback(
    (artifactId: string): Promise<string | null> => {
      return trpcClient.artifacts.getFilePath.query({ id: artifactId })
    },
    [trpcClient]
  )

  return { uploadFiles, getFilePath }
}
