import { useCallback, useEffect, useRef } from 'react'

export interface ArtifactRef {
  id: string
  title: string
}

export interface UseArtifactUploadReturn {
  uploadFiles: (files: File[]) => Promise<ArtifactRef[]>
  getFilePath: (artifactId: string) => Promise<string | null>
}

/**
 * Storage operations behind `useArtifactUpload`. The editor owns this contract;
 * the artifacts feature (`@slayzone/task-artifacts`, which sits ABOVE the
 * editor) provides the real implementation — so the editor never imports the
 * artifacts feature nor calls its tRPC routes.
 */
export interface ArtifactUploader {
  /** Get-or-create the task's folder named `name`; resolves its id (null if none). */
  getOrCreateFolder: (taskId: string, name: string) => Promise<string | null>
  /** Store `bytes` as a new artifact of `taskId`; resolves the created artifact. */
  uploadBlob: (input: {
    taskId: string
    title: string
    bytes: Uint8Array
    folderId: string | null
  }) => Promise<ArtifactRef | null>
  /** Absolute on-disk path of the artifact's file (null if unknown). */
  getFilePath: (artifactId: string) => Promise<string | null>
}

/**
 * A hook returning the uploader. A hook (not a plain object) so the
 * implementation can read context (e.g. the render tree's transport client).
 * It must return a referentially stable object while its inputs are unchanged.
 */
export type UseArtifactUploader = () => ArtifactUploader

let registered: UseArtifactUploader | null = null

/**
 * Called ONCE by the composing app at module scope, before its first render.
 * `useArtifactUpload` calls the injected hook, so it must be the same function
 * on every render for the app's lifetime — a module-level registration (not a
 * context, whose value may change) is what makes that hold. Re-registering the
 * same hook is a no-op; a different one throws.
 */
export function registerArtifactUploader(useUploader: UseArtifactUploader): void {
  if (registered && registered !== useUploader) {
    throw new Error('registerArtifactUploader: an artifact uploader is already registered')
  }
  registered = useUploader
}

function useRegisteredArtifactUploader(): ArtifactUploader {
  if (!registered) {
    throw new Error('useArtifactUpload: the app must call registerArtifactUploader first')
  }
  return registered()
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

// Storage goes through the app-registered `ArtifactUploader` (tRPC's
// `artifacts.*` procedures in the real app) — NOT a `window`-global
// `api.artifacts` / `api.artifactFolders` reach-through, which does not exist
// in the `ElectronAPI` contract at all (@slayzone/types' `api.ts`) and threw on
// paste/drop an image on every host but the Electron app.
export function useArtifactUpload(
  taskId: string | null | undefined,
  options?: UseArtifactUploadOptions
): UseArtifactUploadReturn {
  const uploader = useRegisteredArtifactUploader()
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
        folderId = await uploader.getOrCreateFolder(tid, folderName)
      }
      const results = await Promise.all(
        files.map(async (file): Promise<ArtifactRef | null> => {
          const buf = await file.arrayBuffer()
          const bytes = new Uint8Array(buf)
          const baseTitle =
            file.name && file.name.length > 0
              ? file.name
              : `pasted-${tsSlug()}${extFromMime(file.type)}`
          return uploader.uploadBlob({ taskId: tid, title: baseTitle, bytes, folderId })
        })
      )
      return results.filter((a): a is ArtifactRef => a !== null)
    },
    [uploader]
  )

  const getFilePath = useCallback(
    (artifactId: string): Promise<string | null> => uploader.getFilePath(artifactId),
    [uploader]
  )

  return { uploadFiles, getFilePath }
}
