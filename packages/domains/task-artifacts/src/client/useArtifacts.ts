import { useState, useEffect, useCallback, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTRPC, useSubscription } from '@slayzone/transport/client'
import type {
  TaskArtifact,
  RenderMode,
  CreateArtifactInput,
  UpdateArtifactInput,
  ArtifactFolder,
  UpdateArtifactFolderInput
} from '@slayzone/task/shared'
import type {
  ArtifactVersion,
  VersionRef,
  DiffResult,
  PruneReport
} from '@slayzone/task-artifacts/shared'
import { track } from '@slayzone/telemetry/client'

export interface UseArtifactsReturn {
  artifacts: TaskArtifact[]
  folders: ArtifactFolder[]
  isLoading: boolean
  selectedId: string | null
  setSelectedId: (id: string | null) => void
  // Artifact ops
  createArtifact: (params: {
    title: string
    folderId?: string | null
    renderMode?: RenderMode
    content?: string
    language?: string | null
  }) => Promise<TaskArtifact | null>
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
  listVersions: (
    artifactId: string,
    opts?: { limit?: number; offset?: number }
  ) => Promise<ArtifactVersion[]>
  readVersion: (artifactId: string, versionRef: VersionRef) => Promise<string>
  createVersion: (artifactId: string, name?: string | null) => Promise<ArtifactVersion>
  renameVersion: (
    artifactId: string,
    versionRef: VersionRef,
    newName: string | null
  ) => Promise<ArtifactVersion>
  diffVersions: (artifactId: string, a: VersionRef, b?: VersionRef) => Promise<DiffResult>
  pruneVersions: (
    artifactId: string,
    opts: { keepLast?: number; keepNamed?: boolean; keepCurrent?: boolean; dryRun?: boolean }
  ) => Promise<PruneReport>
  setCurrentVersion: (artifactId: string, versionRef: VersionRef) => Promise<ArtifactVersion>
  // Folder ops
  createFolder: (params: {
    name: string
    parentId?: string | null
  }) => Promise<ArtifactFolder | null>
  updateFolder: (data: UpdateArtifactFolderInput) => Promise<void>
  deleteFolder: (id: string) => Promise<void>
  renameFolder: (id: string, newName: string) => Promise<void>
  // Path helpers
  getArtifactPath: (artifact: TaskArtifact) => string
  pathToFolderId: Map<string, string>
  folderPathMap: Map<string, string>
}

export function useArtifacts(
  taskId: string | null | undefined,
  initialSelectedId?: string | null
): UseArtifactsReturn {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [artifacts, setArtifacts] = useState<TaskArtifact[]>([])
  const [folders, setFolders] = useState<ArtifactFolder[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId ?? null)

  // Re-sync selection when switching tasks
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    setSelectedId(initialSelectedId ?? null)
  }, [taskId])

  // Fetch artifacts + folders. The two queries are the source of truth; local
  // state mirrors them so optimistic mutation updates stay instant and consumers
  // keep reading synchronous arrays.
  const artifactsQuery = useQuery(
    trpc.artifacts.getByTask.queryOptions({ taskId: taskId ?? '' }, { enabled: !!taskId })
  )
  const foldersQuery = useQuery(
    trpc.artifacts.foldersGetByTask.queryOptions({ taskId: taskId ?? '' }, { enabled: !!taskId })
  )

  useEffect(() => {
    if (artifactsQuery.data) setArtifacts(artifactsQuery.data)
  }, [artifactsQuery.data])
  useEffect(() => {
    if (foldersQuery.data) setFolders(foldersQuery.data)
  }, [foldersQuery.data])

  // Clear local state immediately when there is no task (the queries are disabled
  // and won't emit data to drive the effects above).
  useEffect(() => {
    if (!taskId) {
      setArtifacts([])
      setFolders([])
    }
  }, [taskId])

  const isLoading = !!taskId && (artifactsQuery.isPending || foldersQuery.isPending)

  // External changes: refetch both lists when a `tasks-changed` signal fires
  // (replaces the legacy `app.onTasksChanged` IPC listener).
  useSubscription(
    trpc.notify.onTasksChanged.subscriptionOptions(undefined, {
      enabled: !!taskId,
      onData: () => {
        void artifactsQuery.refetch()
        void foldersQuery.refetch()
      }
    })
  )

  // --- Mutations ---
  const createMutation = useMutation(trpc.artifacts.create.mutationOptions())
  const updateMutation = useMutation(trpc.artifacts.update.mutationOptions())
  const deleteMutation = useMutation(trpc.artifacts.delete.mutationOptions())
  const uploadMutation = useMutation(trpc.artifacts.upload.mutationOptions())
  const uploadDirMutation = useMutation(trpc.artifacts.uploadDir.mutationOptions())
  const downloadFileMutation = useMutation(trpc.artifacts.downloadFile.mutationOptions())
  const downloadFolderMutation = useMutation(trpc.artifacts.downloadFolder.mutationOptions())
  const downloadAsPdfMutation = useMutation(trpc.artifacts.downloadAsPdf.mutationOptions())
  const downloadAsPngMutation = useMutation(trpc.artifacts.downloadAsPng.mutationOptions())
  const downloadAsHtmlMutation = useMutation(trpc.artifacts.downloadAsHtml.mutationOptions())
  const downloadAllAsZipMutation = useMutation(trpc.artifacts.downloadAllAsZip.mutationOptions())
  const versionsCreateMutation = useMutation(trpc.artifacts.versionsCreate.mutationOptions())
  const versionsRenameMutation = useMutation(trpc.artifacts.versionsRename.mutationOptions())
  const versionsPruneMutation = useMutation(trpc.artifacts.versionsPrune.mutationOptions())
  const versionsSetCurrentMutation = useMutation(
    trpc.artifacts.versionsSetCurrent.mutationOptions()
  )
  const foldersCreateMutation = useMutation(trpc.artifacts.foldersCreate.mutationOptions())
  const foldersUpdateMutation = useMutation(trpc.artifacts.foldersUpdate.mutationOptions())
  const foldersDeleteMutation = useMutation(trpc.artifacts.foldersDelete.mutationOptions())

  // Build folder path lookup: folderId -> slash-separated path
  const folderPathMap = useMemo(() => {
    const map = new Map<string, string>()
    const byId = new Map(folders.map((f) => [f.id, f]))
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

  const getArtifactPath = useCallback(
    (artifact: TaskArtifact): string => {
      if (!artifact.folder_id) return artifact.title
      const folderPath = folderPathMap.get(artifact.folder_id)
      return folderPath ? `${folderPath}/${artifact.title}` : artifact.title
    },
    [folderPathMap]
  )

  // --- Artifact CRUD ---

  const createArtifact = useCallback(
    async (params: {
      title: string
      folderId?: string | null
      renderMode?: RenderMode
      content?: string
      language?: string | null
    }): Promise<TaskArtifact | null> => {
      if (!taskId) return null
      const data: CreateArtifactInput = { taskId, ...params }
      const artifact = await createMutation.mutateAsync(data)
      if (artifact) {
        setArtifacts((prev) => [...prev, artifact])
        setSelectedId(artifact.id)
        track('asset_created')
      }
      return artifact
    },
    [taskId]
  )

  const updateArtifact = useCallback(
    async (data: UpdateArtifactInput): Promise<void> => {
      const updated = await updateMutation.mutateAsync(data)
      if (updated) {
        setArtifacts((prev) => prev.map((a) => (a.id === data.id ? updated : a)))
      }
    },
    []
  )

  const deleteArtifact = useCallback(
    async (id: string): Promise<void> => {
      await deleteMutation.mutateAsync({ id })
      setArtifacts((prev) => prev.filter((a) => a.id !== id))
      setSelectedId((prev) => (prev === id ? null : prev))
      track('asset_deleted')
    },
    []
  )

  const renameArtifact = useCallback(
    async (id: string, newTitle: string): Promise<void> => {
      const updated = await updateMutation.mutateAsync({ id, title: newTitle })
      if (updated) {
        setArtifacts((prev) => prev.map((a) => (a.id === id ? updated : a)))
      }
    },
    []
  )

  const moveArtifactToFolder = useCallback(
    async (artifactId: string, folderId: string | null): Promise<void> => {
      const updated = await updateMutation.mutateAsync({ id: artifactId, folderId })
      if (updated) {
        setArtifacts((prev) => prev.map((a) => (a.id === artifactId ? updated : a)))
      }
    },
    []
  )

  const readContent = useCallback(
    async (id: string): Promise<string | null> => {
      return queryClient.fetchQuery(trpc.artifacts.readContent.queryOptions({ id }))
    },
    [queryClient, trpc]
  )

  const saveContent = useCallback(
    async (id: string, content: string): Promise<void> => {
      // UI saves always mutate the latest version in place. The explicit
      // "Create version" action is the only UI path that creates new versions.
      await updateMutation.mutateAsync({ id, content, mutateVersion: true })
    },
    []
  )

  const uploadArtifact = useCallback(
    async (sourcePath: string, title?: string): Promise<TaskArtifact | null> => {
      if (!taskId) return null
      const artifact = await uploadMutation.mutateAsync({ taskId, sourcePath, title })
      if (artifact) {
        setArtifacts((prev) => [...prev, artifact])
        setSelectedId(artifact.id)
        track('asset_created')
      }
      return artifact
    },
    [taskId]
  )

  const getFilePath = useCallback(
    async (id: string): Promise<string | null> => {
      return queryClient.fetchQuery(trpc.artifacts.getFilePath.queryOptions({ id }))
    },
    [queryClient, trpc]
  )

  const downloadFile = useCallback(
    async (id: string): Promise<boolean> => {
      return downloadFileMutation.mutateAsync({ id })
    },
    []
  )

  const downloadFolder = useCallback(
    async (id: string): Promise<boolean> => {
      return downloadFolderMutation.mutateAsync({ folderId: id })
    },
    []
  )

  const downloadAsPdf = useCallback(
    async (id: string): Promise<boolean> => {
      return downloadAsPdfMutation.mutateAsync({ id })
    },
    []
  )

  const downloadAsPng = useCallback(
    async (id: string): Promise<boolean> => {
      return downloadAsPngMutation.mutateAsync({ id })
    },
    []
  )

  const downloadAsHtml = useCallback(
    async (id: string): Promise<boolean> => {
      return downloadAsHtmlMutation.mutateAsync({ id })
    },
    []
  )

  const downloadAllAsZip = useCallback(async (): Promise<boolean> => {
    if (!taskId) return false
    return downloadAllAsZipMutation.mutateAsync({ taskId })
  }, [taskId])

  const uploadDir = useCallback(
    async (dirPath: string, parentFolderId?: string | null): Promise<void> => {
      if (!taskId) return
      await uploadDirMutation.mutateAsync({
        taskId,
        dirPath,
        parentFolderId: parentFolderId ?? null
      })
      // Reload everything after bulk operation
      const [newArtifacts, newFolders] = await Promise.all([
        queryClient.fetchQuery(trpc.artifacts.getByTask.queryOptions({ taskId })),
        queryClient.fetchQuery(trpc.artifacts.foldersGetByTask.queryOptions({ taskId }))
      ])
      setArtifacts(newArtifacts)
      setFolders(newFolders)
    },
    [taskId, queryClient, trpc]
  )

  // --- Versions ---

  const listVersions = useCallback(
    async (
      artifactId: string,
      opts?: { limit?: number; offset?: number }
    ): Promise<ArtifactVersion[]> => {
      return queryClient.fetchQuery(
        trpc.artifacts.versionsList.queryOptions({ artifactId, ...opts })
      )
    },
    [queryClient, trpc]
  )

  const readVersion = useCallback(
    async (artifactId: string, versionRef: VersionRef): Promise<string> => {
      return queryClient.fetchQuery(
        trpc.artifacts.versionsRead.queryOptions({ artifactId, versionRef })
      )
    },
    [queryClient, trpc]
  )

  const createVersion = useCallback(
    async (artifactId: string, name?: string | null): Promise<ArtifactVersion> => {
      return versionsCreateMutation.mutateAsync({ artifactId, name })
    },
    []
  )

  const renameVersion = useCallback(
    async (
      artifactId: string,
      versionRef: VersionRef,
      newName: string | null
    ): Promise<ArtifactVersion> => {
      return versionsRenameMutation.mutateAsync({ artifactId, versionRef, newName })
    },
    []
  )

  const diffVersions = useCallback(
    async (artifactId: string, a: VersionRef, b?: VersionRef): Promise<DiffResult> => {
      return queryClient.fetchQuery(
        trpc.artifacts.versionsDiff.queryOptions({ artifactId, a, b })
      )
    },
    [queryClient, trpc]
  )

  const pruneVersions = useCallback(
    async (
      artifactId: string,
      opts: { keepLast?: number; keepNamed?: boolean; keepCurrent?: boolean; dryRun?: boolean }
    ): Promise<PruneReport> => {
      return versionsPruneMutation.mutateAsync({ artifactId, ...opts })
    },
    []
  )

  const setCurrentVersion = useCallback(
    async (artifactId: string, versionRef: VersionRef): Promise<ArtifactVersion> => {
      const v = await versionsSetCurrentMutation.mutateAsync({ artifactId, versionRef })
      // Refresh artifact rows so current_version_id in local state matches DB.
      if (taskId) {
        const refreshed = await queryClient.fetchQuery(
          trpc.artifacts.getByTask.queryOptions({ taskId })
        )
        setArtifacts(refreshed)
      }
      return v
    },
    [taskId, queryClient, trpc]
  )

  // --- Folder CRUD ---

  const createFolder = useCallback(
    async (params: { name: string; parentId?: string | null }): Promise<ArtifactFolder | null> => {
      if (!taskId) return null
      const folder = await foldersCreateMutation.mutateAsync({ taskId, ...params })
      if (folder) {
        setFolders((prev) => [...prev, folder])
      }
      return folder
    },
    [taskId]
  )

  const updateFolder = useCallback(
    async (data: UpdateArtifactFolderInput): Promise<void> => {
      const updated = await foldersUpdateMutation.mutateAsync(data)
      if (updated) {
        setFolders((prev) => prev.map((f) => (f.id === data.id ? updated : f)))
      }
    },
    []
  )

  const deleteFolder = useCallback(
    async (id: string): Promise<void> => {
      await foldersDeleteMutation.mutateAsync({ id })
      setFolders((prev) => prev.filter((f) => f.id !== id))
      // Artifacts in deleted folder get folder_id = NULL (DB handles it), refresh local state
      setArtifacts((prev) => prev.map((a) => (a.folder_id === id ? { ...a, folder_id: null } : a)))
    },
    []
  )

  const renameFolder = useCallback(
    async (id: string, newName: string): Promise<void> => {
      const updated = await foldersUpdateMutation.mutateAsync({ id, name: newName })
      if (updated) {
        setFolders((prev) => prev.map((f) => (f.id === id ? updated : f)))
      }
    },
    []
  )

  return {
    artifacts,
    folders,
    isLoading,
    selectedId,
    setSelectedId,
    createArtifact,
    updateArtifact,
    deleteArtifact,
    renameArtifact,
    moveArtifactToFolder,
    readContent,
    saveContent,
    uploadArtifact,
    uploadDir,
    getFilePath,
    downloadFile,
    downloadFolder,
    downloadAsPdf,
    downloadAsPng,
    downloadAsHtml,
    downloadAllAsZip,
    listVersions,
    readVersion,
    createVersion,
    renameVersion,
    diffVersions,
    pruneVersions,
    setCurrentVersion,
    createFolder,
    updateFolder,
    deleteFolder,
    renameFolder,
    getArtifactPath,
    pathToFolderId,
    folderPathMap
  }
}
