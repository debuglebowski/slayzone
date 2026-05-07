import { useState, useEffect, useCallback, useMemo } from 'react'
import { getTrpcVanillaClient } from '@slayzone/transport/client'
import type { TaskArtifact, RenderMode, CreateArtifactInput, UpdateArtifactInput, ArtifactFolder, UpdateArtifactFolderInput } from '@slayzone/task/shared'
import type { ArtifactVersion, VersionRef, DiffResult, PruneReport } from '@slayzone/task-artifacts/shared'
import { track } from '@slayzone/telemetry/client'

export interface UseArtifactsReturn {
  artifacts: TaskArtifact[]
  folders: ArtifactFolder[]
  isLoading: boolean
  selectedId: string | null
  setSelectedId: (id: string | null) => void
  // Artifact ops
  createArtifact: (params: { title: string; folderId?: string | null; renderMode?: RenderMode; content?: string; language?: string | null }) => Promise<TaskArtifact | null>
  updateArtifact: (data: UpdateArtifactInput) => Promise<void>
  deleteArtifact: (id: string) => Promise<void>
  renameArtifact: (id: string, newTitle: string) => Promise<void>
  moveArtifactToFolder: (artifactId: string, folderId: string | null) => Promise<void>
  readContent: (id: string) => Promise<string | null>
  saveContent: (id: string, content: string) => Promise<void>
  uploadArtifact: (sourcePath: string, title?: string) => Promise<TaskArtifact | null>
  uploadDir: (dirPath: string, parentFolderId?: string | null) => Promise<void>
  getFilePath: (id: string) => Promise<string | null>
  downloadFile: (id: string) => Promise<boolean>
  downloadFolder: (id: string) => Promise<boolean>
  downloadAsPdf: (id: string) => Promise<boolean>
  downloadAsPng: (id: string) => Promise<boolean>
  downloadAsHtml: (id: string) => Promise<boolean>
  downloadAllAsZip: () => Promise<boolean>
  // Versions
  listVersions: (artifactId: string, opts?: { limit?: number; offset?: number }) => Promise<ArtifactVersion[]>
  readVersion: (artifactId: string, versionRef: VersionRef) => Promise<string>
  createVersion: (artifactId: string, name?: string | null) => Promise<ArtifactVersion>
  renameVersion: (artifactId: string, versionRef: VersionRef, newName: string | null) => Promise<ArtifactVersion>
  diffVersions: (artifactId: string, a: VersionRef, b?: VersionRef) => Promise<DiffResult>
  pruneVersions: (artifactId: string, opts: { keepLast?: number; keepNamed?: boolean; keepCurrent?: boolean; dryRun?: boolean }) => Promise<PruneReport>
  setCurrentVersion: (artifactId: string, versionRef: VersionRef) => Promise<ArtifactVersion>
  // Folder ops
  createFolder: (params: { name: string; parentId?: string | null }) => Promise<ArtifactFolder | null>
  updateFolder: (data: UpdateArtifactFolderInput) => Promise<void>
  deleteFolder: (id: string) => Promise<void>
  renameFolder: (id: string, newName: string) => Promise<void>
  // Path helpers
  getArtifactPath: (artifact: TaskArtifact) => string
  pathToFolderId: Map<string, string>
  folderPathMap: Map<string, string>
}

export function useArtifacts(taskId: string | null | undefined, initialSelectedId?: string | null): UseArtifactsReturn {
  const [artifacts, setArtifacts] = useState<TaskArtifact[]>([])
  const [folders, setFolders] = useState<ArtifactFolder[]>([])
  const [isLoading, setIsLoading] = useState<boolean>(!!taskId)
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId ?? null)

  // Re-sync selection when switching tasks
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setSelectedId(initialSelectedId ?? null) }, [taskId])

  // Fetch artifacts + folders on mount and external changes
  useEffect(() => {
    if (!taskId) { setIsLoading(false); return }
    setIsLoading(true)
    let cancelled = false
    let firstLoad = true
    const load = (): void => {
      const p = Promise.all([
        getTrpcVanillaClient().task.artifactsGetByTask.query({ taskId: taskId }).then(r => { if (!cancelled) setArtifacts(r) }).catch(() => {}),
        getTrpcVanillaClient().task.foldersGetByTask.query({ taskId: taskId }).then(r => { if (!cancelled) setFolders(r) }).catch(() => {}),
      ])
      if (firstLoad) {
        firstLoad = false
        p.finally(() => { if (!cancelled) setIsLoading(false) })
      }
    }
    load()
    const _sub = getTrpcVanillaClient().task.onChanged.subscribe(undefined, { onData: () => load() }); const cleanup = () => _sub.unsubscribe()
    return () => { cancelled = true; cleanup?.() }
  }, [taskId])

  // Build folder path lookup: folderId -> slash-separated path
  const folderPathMap = useMemo(() => {
    const map = new Map<string, string>()
    const byId = new Map(folders.map(f => [f.id, f]))
    function resolve(id: string): string {
      if (map.has(id)) return map.get(id)!
      const f = byId.get(id)
      if (!f) return ''
      const path = f.parent_id ? `${resolve(f.parent_id)}/${f.name}` : f.name
      map.set(id, path)
      return path
    }
    for (const f of folders) resolve(f.id)
    return map
  }, [folders])

  // Reverse lookup: path string -> folderId
  const pathToFolderId = useMemo(() => {
    const map = new Map<string, string>()
    for (const [id, path] of folderPathMap) map.set(path, id)
    return map
  }, [folderPathMap])

  const getArtifactPath = useCallback((artifact: TaskArtifact): string => {
    if (!artifact.folder_id) return artifact.title
    const folderPath = folderPathMap.get(artifact.folder_id)
    return folderPath ? `${folderPath}/${artifact.title}` : artifact.title
  }, [folderPathMap])

  // --- Artifact CRUD ---

  const createArtifact = useCallback(async (params: { title: string; folderId?: string | null; renderMode?: RenderMode; content?: string; language?: string | null }): Promise<TaskArtifact | null> => {
    if (!taskId) return null
    const data: CreateArtifactInput = { taskId, ...params }
    const artifact = await getTrpcVanillaClient().task.artifactsCreate.mutate(data)
    if (artifact) {
      setArtifacts(prev => [...prev, artifact])
      setSelectedId(artifact.id)
      track('asset_created')
    }
    return artifact
  }, [taskId])

  const updateArtifact = useCallback(async (data: UpdateArtifactInput): Promise<void> => {
    const updated = await getTrpcVanillaClient().task.artifactsUpdate.mutate(data)
    if (updated) {
      setArtifacts(prev => prev.map(a => a.id === data.id ? updated : a))
    }
  }, [])

  const deleteArtifact = useCallback(async (id: string): Promise<void> => {
    await getTrpcVanillaClient().task.artifactsDelete.mutate({ id: id })
    setArtifacts(prev => prev.filter(a => a.id !== id))
    setSelectedId(prev => prev === id ? null : prev)
    track('asset_deleted')
  }, [])

  const renameArtifact = useCallback(async (id: string, newTitle: string): Promise<void> => {
    const updated = await getTrpcVanillaClient().task.artifactsUpdate.mutate({ id, title: newTitle })
    if (updated) {
      setArtifacts(prev => prev.map(a => a.id === id ? updated : a))
    }
  }, [])

  const moveArtifactToFolder = useCallback(async (artifactId: string, folderId: string | null): Promise<void> => {
    const updated = await getTrpcVanillaClient().task.artifactsUpdate.mutate({ id: artifactId, folderId })
    if (updated) {
      setArtifacts(prev => prev.map(a => a.id === artifactId ? updated : a))
    }
  }, [])

  const readContent = useCallback(async (id: string): Promise<string | null> => {
    return getTrpcVanillaClient().task.artifactsReadContent.query({ id: id })
  }, [])

  const saveContent = useCallback(async (id: string, content: string): Promise<void> => {
    // UI saves always mutate the latest version in place. The explicit
    // "Create version" action is the only UI path that creates new versions.
    await getTrpcVanillaClient().task.artifactsUpdate.mutate({ id, content, mutateVersion: true })
  }, [])

  const uploadArtifact = useCallback(async (sourcePath: string, title?: string): Promise<TaskArtifact | null> => {
    if (!taskId) return null
    const artifact = await getTrpcVanillaClient().task.artifactsUpload.mutate({ taskId, sourcePath, title })
    if (artifact) {
      setArtifacts(prev => [...prev, artifact])
      setSelectedId(artifact.id)
      track('asset_created')
    }
    return artifact
  }, [taskId])

  const getFilePath = useCallback(async (id: string): Promise<string | null> => {
    return getTrpcVanillaClient().task.artifactsGetFilePath.query({ id: id })
  }, [])

  const downloadFile = useCallback(async (id: string): Promise<boolean> => {
    return getTrpcVanillaClient().task.artifactsDownloadFile.mutate({ id: id })
  }, [])

  const downloadFolder = useCallback(async (id: string): Promise<boolean> => {
    return getTrpcVanillaClient().task.artifactsDownloadFolder.mutate({ folderId: id })
  }, [])

  const downloadAsPdf = useCallback(async (id: string): Promise<boolean> => {
    return getTrpcVanillaClient().task.artifactsDownloadAsPdf.mutate({ id: id })
  }, [])

  const downloadAsPng = useCallback(async (id: string): Promise<boolean> => {
    return getTrpcVanillaClient().task.artifactsDownloadAsPng.mutate({ id: id })
  }, [])

  const downloadAsHtml = useCallback(async (id: string): Promise<boolean> => {
    return getTrpcVanillaClient().task.artifactsDownloadAsHtml.mutate({ id: id })
  }, [])

  const downloadAllAsZip = useCallback(async (): Promise<boolean> => {
    if (!taskId) return false
    return getTrpcVanillaClient().task.artifactsDownloadAllAsZip.mutate({ taskId: taskId })
  }, [taskId])

  const uploadDir = useCallback(async (dirPath: string, parentFolderId?: string | null): Promise<void> => {
    if (!taskId) return
    await getTrpcVanillaClient().task.artifactsUploadDir.mutate({ taskId, dirPath, parentFolderId: parentFolderId ?? null })
    // Reload everything after bulk operation
    const [newArtifacts, newFolders] = await Promise.all([
      getTrpcVanillaClient().task.artifactsGetByTask.query({ taskId: taskId }),
      getTrpcVanillaClient().task.foldersGetByTask.query({ taskId: taskId }),
    ])
    setArtifacts(newArtifacts)
    setFolders(newFolders)
  }, [taskId])

  // --- Versions ---

  const listVersions = useCallback(async (artifactId: string, opts?: { limit?: number; offset?: number }): Promise<ArtifactVersion[]> => {
    return getTrpcVanillaClient().task.versionsList.query({ artifactId, ...opts })
  }, [])

  const readVersion = useCallback(async (artifactId: string, versionRef: VersionRef): Promise<string> => {
    return getTrpcVanillaClient().task.versionsRead.query({ artifactId, versionRef })
  }, [])

  const createVersion = useCallback(async (artifactId: string, name?: string | null): Promise<ArtifactVersion> => {
    return getTrpcVanillaClient().task.versionsCreate.mutate({ artifactId, name })
  }, [])

  const renameVersion = useCallback(async (artifactId: string, versionRef: VersionRef, newName: string | null): Promise<ArtifactVersion> => {
    return getTrpcVanillaClient().task.versionsRename.mutate({ artifactId, versionRef, newName })
  }, [])

  const diffVersions = useCallback(async (artifactId: string, a: VersionRef, b?: VersionRef): Promise<DiffResult> => {
    return getTrpcVanillaClient().task.versionsDiff.query({ artifactId, a, b })
  }, [])

  const pruneVersions = useCallback(async (artifactId: string, opts: { keepLast?: number; keepNamed?: boolean; keepCurrent?: boolean; dryRun?: boolean }): Promise<PruneReport> => {
    return getTrpcVanillaClient().task.versionsPrune.mutate({ artifactId, ...opts })
  }, [])

  const setCurrentVersion = useCallback(async (artifactId: string, versionRef: VersionRef): Promise<ArtifactVersion> => {
    const v = await getTrpcVanillaClient().task.versionsSetCurrent.mutate({ artifactId, versionRef })
    // Refresh artifact rows so current_version_id in local state matches DB.
    if (taskId) {
      const refreshed = await getTrpcVanillaClient().task.artifactsGetByTask.query({ taskId: taskId })
      setArtifacts(refreshed)
    }
    return v
  }, [taskId])

  // --- Folder CRUD ---

  const createFolder = useCallback(async (params: { name: string; parentId?: string | null }): Promise<ArtifactFolder | null> => {
    if (!taskId) return null
    const folder = await getTrpcVanillaClient().task.foldersCreate.mutate({ taskId, ...params })
    if (folder) {
      setFolders(prev => [...prev, folder])
    }
    return folder
  }, [taskId])

  const updateFolder = useCallback(async (data: UpdateArtifactFolderInput): Promise<void> => {
    const updated = await getTrpcVanillaClient().task.foldersUpdate.mutate(data)
    if (updated) {
      setFolders(prev => prev.map(f => f.id === data.id ? updated : f))
    }
  }, [])

  const deleteFolder = useCallback(async (id: string): Promise<void> => {
    await getTrpcVanillaClient().task.foldersDelete.mutate({ id: id })
    setFolders(prev => prev.filter(f => f.id !== id))
    // Artifacts in deleted folder get folder_id = NULL (DB handles it), refresh local state
    setArtifacts(prev => prev.map(a => a.folder_id === id ? { ...a, folder_id: null } : a))
  }, [])

  const renameFolder = useCallback(async (id: string, newName: string): Promise<void> => {
    const updated = await getTrpcVanillaClient().task.foldersUpdate.mutate({ id, name: newName })
    if (updated) {
      setFolders(prev => prev.map(f => f.id === id ? updated : f))
    }
  }, [])

  return {
    artifacts, folders, isLoading, selectedId, setSelectedId,
    createArtifact, updateArtifact, deleteArtifact, renameArtifact, moveArtifactToFolder,
    readContent, saveContent, uploadArtifact, uploadDir, getFilePath,
    downloadFile, downloadFolder, downloadAsPdf, downloadAsPng, downloadAsHtml, downloadAllAsZip,
    listVersions, readVersion, createVersion, renameVersion, diffVersions, pruneVersions, setCurrentVersion,
    createFolder, updateFolder, deleteFolder, renameFolder,
    getArtifactPath, pathToFolderId, folderPathMap,
  }
}
