import { useCallback, useEffect, useRef } from 'react'

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

interface ArtifactsApiNarrow {
  uploadBlob: (data: {
    taskId: string
    title: string
    bytes: Uint8Array
    folderId?: string | null
  }) => Promise<ArtifactRef | null>
  getFilePath: (id: string) => Promise<string | null>
}

interface ArtifactFoldersApiNarrow {
  getOrCreateByName: (data: { taskId: string; name: string }) => Promise<{ id: string } | null>
}

function getArtifactsApi(): ArtifactsApiNarrow {
  return (window as unknown as { api: { artifacts: ArtifactsApiNarrow } }).api.artifacts
}

function getArtifactFoldersApi(): ArtifactFoldersApiNarrow {
  return (window as unknown as { api: { artifactFolders: ArtifactFoldersApiNarrow } }).api
    .artifactFolders
}

export interface UseArtifactUploadOptions {
  folderName?: string
}

export function useArtifactUpload(
  taskId: string | null | undefined,
  options?: UseArtifactUploadOptions
): UseArtifactUploadReturn {
  const taskIdRef = useRef(taskId)
  useEffect(() => {
    taskIdRef.current = taskId
  })
  const folderNameRef = useRef(options?.folderName)
  useEffect(() => {
    folderNameRef.current = options?.folderName
  })

  const uploadFiles = useCallback(async (files: File[]): Promise<ArtifactRef[]> => {
    const tid = taskIdRef.current
    if (!tid) return []
    const artifacts = getArtifactsApi()
    let folderId: string | null = null
    const folderName = folderNameRef.current
    if (folderName) {
      const folder = await getArtifactFoldersApi().getOrCreateByName({
        taskId: tid,
        name: folderName
      })
      folderId = folder?.id ?? null
    }
    const results = await Promise.all(
      files.map(async (file) => {
        const buf = await file.arrayBuffer()
        const bytes = new Uint8Array(buf)
        const baseTitle =
          file.name && file.name.length > 0
            ? file.name
            : `pasted-${tsSlug()}${extFromMime(file.type)}`
        return artifacts.uploadBlob({ taskId: tid, title: baseTitle, bytes, folderId })
      })
    )
    return results.filter((a): a is ArtifactRef => a !== null)
  }, [])

  const getFilePath = useCallback((artifactId: string): Promise<string | null> => {
    return getArtifactsApi().getFilePath(artifactId)
  }, [])

  return { uploadFiles, getFilePath }
}
