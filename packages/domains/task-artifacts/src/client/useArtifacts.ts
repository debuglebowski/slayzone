import { useState, useEffect, useCallback, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
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
import { toast, useDepsChanged, useStableCallback } from '@slayzone/ui'

// Downloads reach the Electron host over the capability bridge, so they can fail for
// reasons the user must see (no host capability, render failure, unwritable path).
// These mutations were previously fired bare: a rejection became an unhandled promise
// and the click looked like a no-op — which is how all 6 procedures stayed broken
// unnoticed after the slice-9 cutover. `false` still means "user cancelled".
async function runDownload(label: string, run: () => Promise<boolean>): Promise<boolean> {
  try {
    return await run()
  } catch (e) {
    toast.error(`${label} failed`, { description: e instanceof Error ? e.message : String(e) })
    return false
  }
}

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

/**
 * The selected artifact, reconciled with the task's saved one (`active_artifact_id`,
 * passed in as `initialSelectedId`). The panel saves each selection 500 ms after it
 * is made (usePersistenceSaves), so the saved value trails a selection made here;
 * other windows and clients of the same task save theirs to the same field.
 */
interface Selection {
  /** The task this selection is for. */
  taskId: string | null | undefined
  /** The selected artifact. */
  id: string | null
  /** The task's saved selection, as last seen. */
  saved: string | null
  /** `saved` changed to another artifact after the last selection made here. */
  savedIsNewer: boolean
}

const selectionFor = (taskId: string | null | undefined, saved: string | null): Selection => ({
  taskId,
  id: saved,
  saved,
  savedIsNewer: false
})

export function useArtifacts(
  taskId: string | null | undefined,
  initialSelectedId?: string | null
): UseArtifactsReturn {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [artifacts, setArtifacts] = useState<TaskArtifact[]>([])
  const [folders, setFolders] = useState<ArtifactFolder[]>([])

  const saved = initialSelectedId ?? null
  const [selection, setSelection] = useState<Selection>(() => selectionFor(taskId, saved))
  const selectedId = selection.id
  // A new saved value for the same task: this panel's own save landing (it matches the
  // selection), or a selection saved from another window or client. Recorded while
  // rendering; adopted by the sync below.
  if (Object.is(selection.taskId, taskId) && !Object.is(selection.saved, saved)) {
    setSelection((s) => ({ ...s, saved, savedIsNewer: saved !== s.id }))
  }
  // On mount, a task change, and every tab re-show (<Activity> re-runs this): a task
  // change selects that task's saved artifact (the stable callback reads the latest
  // `initialSelectedId`). Otherwise the saved artifact is adopted only when it was saved
  // after the last selection made here: a re-show inside the save window must not put
  // back the previous artifact (it also collapsed a multi-select).
  const syncSelection = useStableCallback(() => {
    setSelection((s) => {
      if (!Object.is(s.taskId, taskId)) return selectionFor(taskId, saved)
      return s.savedIsNewer ? { ...s, id: s.saved, savedIsNewer: false } : s
    })
  })
  useEffect(() => {
    syncSelection()
  }, [taskId, syncSelection])
  // A selection made here (a click, the search panel, the panel's imperative handle,
  // create / upload): newer than anything saved so far.
  const setSelectedId = useCallback((id: string | null) => {
    setSelection((s) => (s.id === id && !s.savedIsNewer ? s : { ...s, id, savedIsNewer: false }))
  }, [])

  // Fetch artifacts + folders. The two queries are the source of truth; local
  // state mirrors them so optimistic mutation updates stay instant and consumers
  // keep reading synchronous arrays.
  const artifactsQuery = useQuery(
    trpc.artifacts.getByTask.queryOptions({ taskId: taskId ?? '' }, { enabled: !!taskId })
  )
  const foldersQuery = useQuery(
    trpc.artifacts.foldersGetByTask.queryOptions({ taskId: taskId ?? '' }, { enabled: !!taskId })
  )

  // Mirror only when a query hands over NEW data (a fetch or refetch — including
  // the reveal refetch of a `tasks-changed` refresh deferred while the tab was
  // hidden). Adjusted while rendering, keyed on the data's identity: an effect
  // also re-ran on every tab re-show (<Activity>) and reverted the local edits
  // below to the older cached data.
  const artifactsDataChanged = useDepsChanged([artifactsQuery.data], true)
  if (artifactsDataChanged && artifactsQuery.data) setArtifacts(artifactsQuery.data)
  const foldersDataChanged = useDepsChanged([foldersQuery.data], true)
  if (foldersDataChanged && foldersQuery.data) setFolders(foldersQuery.data)

  // Clear local state immediately when there is no task (the queries are disabled
  // and won't emit data to drive the effects above). Adjusted during render —
  // same trigger as a `[taskId]` effect, whose mount run was a content no-op
  // (both lists start empty).
  const [stateTaskId, setStateTaskId] = useState(taskId)
  if (!Object.is(stateTaskId, taskId)) {
    setStateTaskId(taskId)
    if (!taskId) {
      setArtifacts([])
      setFolders([])
    }
  }

  const isLoading = !!taskId && (artifactsQuery.isPending || foldersQuery.isPending)

  // External changes refetch both lists through the app's single `tasks-changed`
  // subscription (`refreshTaskScopedQueries` in @slayzone/task), which scopes it
  // to the changed tasks and defers it while this task's tab is hidden.

  // --- Mutations ---
  // mutateAsync is a stable (bound) function across renders — the callbacks below
  // depend on it rather than the per-render mutation result object.
  const { mutateAsync: createMutate } = useMutation(trpc.artifacts.create.mutationOptions())
  const { mutateAsync: updateMutate } = useMutation(trpc.artifacts.update.mutationOptions())
  const { mutateAsync: deleteMutate } = useMutation(trpc.artifacts.delete.mutationOptions())
  const { mutateAsync: uploadMutate } = useMutation(trpc.artifacts.upload.mutationOptions())
  const { mutateAsync: uploadDirMutate } = useMutation(trpc.artifacts.uploadDir.mutationOptions())
  const { mutateAsync: downloadFileMutate } = useMutation(
    trpc.artifacts.downloadFile.mutationOptions()
  )
  const { mutateAsync: downloadFolderMutate } = useMutation(
    trpc.artifacts.downloadFolder.mutationOptions()
  )
  const { mutateAsync: downloadAsPdfMutate } = useMutation(
    trpc.artifacts.downloadAsPdf.mutationOptions()
  )
  const { mutateAsync: downloadAsPngMutate } = useMutation(
    trpc.artifacts.downloadAsPng.mutationOptions()
  )
  const { mutateAsync: downloadAsHtmlMutate } = useMutation(
    trpc.artifacts.downloadAsHtml.mutationOptions()
  )
  const { mutateAsync: downloadAllAsZipMutate } = useMutation(
    trpc.artifacts.downloadAllAsZip.mutationOptions()
  )
  const { mutateAsync: versionsCreateMutate } = useMutation(
    trpc.artifacts.versionsCreate.mutationOptions()
  )
  const { mutateAsync: versionsRenameMutate } = useMutation(
    trpc.artifacts.versionsRename.mutationOptions()
  )
  const { mutateAsync: versionsPruneMutate } = useMutation(
    trpc.artifacts.versionsPrune.mutationOptions()
  )
  const { mutateAsync: versionsSetCurrentMutate } = useMutation(
    trpc.artifacts.versionsSetCurrent.mutationOptions()
  )
  const { mutateAsync: foldersCreateMutate } = useMutation(
    trpc.artifacts.foldersCreate.mutationOptions()
  )
  const { mutateAsync: foldersUpdateMutate } = useMutation(
    trpc.artifacts.foldersUpdate.mutationOptions()
  )
  const { mutateAsync: foldersDeleteMutate } = useMutation(
    trpc.artifacts.foldersDelete.mutationOptions()
  )

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
      const artifact = await createMutate(data)
      if (artifact) {
        setArtifacts((prev) => [...prev, artifact])
        setSelectedId(artifact.id)
        track('asset_created')
      }
      return artifact
    },
    [taskId, createMutate, setSelectedId]
  )

  const updateArtifact = useCallback(
    async (data: UpdateArtifactInput): Promise<void> => {
      const updated = await updateMutate(data)
      if (updated) {
        setArtifacts((prev) => prev.map((a) => (a.id === data.id ? updated : a)))
      }
    },
    [updateMutate]
  )

  const deleteArtifact = useCallback(
    async (id: string): Promise<void> => {
      await deleteMutate({ id })
      setArtifacts((prev) => prev.filter((a) => a.id !== id))
      setSelection((s) => (s.id === id ? { ...s, id: null, savedIsNewer: false } : s))
      track('asset_deleted')
    },
    [deleteMutate]
  )

  const renameArtifact = useCallback(
    async (id: string, newTitle: string): Promise<void> => {
      const updated = await updateMutate({ id, title: newTitle })
      if (updated) {
        setArtifacts((prev) => prev.map((a) => (a.id === id ? updated : a)))
      }
    },
    [updateMutate]
  )

  const moveArtifactToFolder = useCallback(
    async (artifactId: string, folderId: string | null): Promise<void> => {
      const updated = await updateMutate({ id: artifactId, folderId })
      if (updated) {
        setArtifacts((prev) => prev.map((a) => (a.id === artifactId ? updated : a)))
      }
    },
    [updateMutate]
  )

  const readContent = useCallback(
    async (id: string): Promise<string | null> => {
      // Disk is the source of truth for artifact content, and this is the reload
      // path (mount + external-change reload in ArtifactContentEditor.loadFromDisk).
      // `fetchQuery` would serve a STALE cached read — e.g. the initial empty ''
      // captured on mount — so a post-save reload (the fs.watch onContentChanged
      // that fires for our OWN write, after dirty was cleared) wipes the editor
      // back to the cached empty string. staleTime:0 forces a fresh disk read.
      return queryClient.fetchQuery(
        trpc.artifacts.readContent.queryOptions({ id }, { staleTime: 0, gcTime: 0 })
      )
    },
    [queryClient, trpc]
  )

  const saveContent = useCallback(
    async (id: string, content: string): Promise<void> => {
      // UI saves always mutate the latest version in place. The explicit
      // "Create version" action is the only UI path that creates new versions.
      await updateMutate({ id, content, mutateVersion: true })
    },
    [updateMutate]
  )

  const uploadArtifact = useCallback(
    async (sourcePath: string, title?: string): Promise<TaskArtifact | null> => {
      if (!taskId) return null
      const artifact = await uploadMutate({ taskId, sourcePath, title })
      if (artifact) {
        setArtifacts((prev) => [...prev, artifact])
        setSelectedId(artifact.id)
        track('asset_created')
      }
      return artifact
    },
    [taskId, uploadMutate, setSelectedId]
  )

  const getFilePath = useCallback(
    async (id: string): Promise<string | null> => {
      return queryClient.fetchQuery(trpc.artifacts.getFilePath.queryOptions({ id }))
    },
    [queryClient, trpc]
  )

  const downloadFile = useCallback(
    async (id: string): Promise<boolean> =>
      runDownload('Download', () => downloadFileMutate({ id })),
    [downloadFileMutate]
  )

  const downloadFolder = useCallback(
    async (id: string): Promise<boolean> =>
      runDownload('Folder download', () => downloadFolderMutate({ folderId: id })),
    [downloadFolderMutate]
  )

  const downloadAsPdf = useCallback(
    async (id: string): Promise<boolean> =>
      runDownload('PDF export', () => downloadAsPdfMutate({ id })),
    [downloadAsPdfMutate]
  )

  const downloadAsPng = useCallback(
    async (id: string): Promise<boolean> =>
      runDownload('PNG export', () => downloadAsPngMutate({ id })),
    [downloadAsPngMutate]
  )

  const downloadAsHtml = useCallback(
    async (id: string): Promise<boolean> =>
      runDownload('HTML export', () => downloadAsHtmlMutate({ id })),
    [downloadAsHtmlMutate]
  )

  const downloadAllAsZip = useCallback(async (): Promise<boolean> => {
    if (!taskId) return false
    return runDownload('ZIP export', () => downloadAllAsZipMutate({ taskId }))
  }, [taskId, downloadAllAsZipMutate])

  const uploadDir = useCallback(
    async (dirPath: string, parentFolderId?: string | null): Promise<void> => {
      if (!taskId) return
      await uploadDirMutate({
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
    [taskId, queryClient, trpc, uploadDirMutate]
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
      return versionsCreateMutate({ artifactId, name })
    },
    [versionsCreateMutate]
  )

  const renameVersion = useCallback(
    async (
      artifactId: string,
      versionRef: VersionRef,
      newName: string | null
    ): Promise<ArtifactVersion> => {
      return versionsRenameMutate({ artifactId, versionRef, newName })
    },
    [versionsRenameMutate]
  )

  const diffVersions = useCallback(
    async (artifactId: string, a: VersionRef, b?: VersionRef): Promise<DiffResult> => {
      return queryClient.fetchQuery(trpc.artifacts.versionsDiff.queryOptions({ artifactId, a, b }))
    },
    [queryClient, trpc]
  )

  const pruneVersions = useCallback(
    async (
      artifactId: string,
      opts: { keepLast?: number; keepNamed?: boolean; keepCurrent?: boolean; dryRun?: boolean }
    ): Promise<PruneReport> => {
      return versionsPruneMutate({ artifactId, ...opts })
    },
    [versionsPruneMutate]
  )

  const setCurrentVersion = useCallback(
    async (artifactId: string, versionRef: VersionRef): Promise<ArtifactVersion> => {
      const v = await versionsSetCurrentMutate({ artifactId, versionRef })
      // Refresh artifact rows so current_version_id in local state matches DB.
      if (taskId) {
        const refreshed = await queryClient.fetchQuery(
          trpc.artifacts.getByTask.queryOptions({ taskId })
        )
        setArtifacts(refreshed)
      }
      return v
    },
    [taskId, queryClient, trpc, versionsSetCurrentMutate]
  )

  // --- Folder CRUD ---

  const createFolder = useCallback(
    async (params: { name: string; parentId?: string | null }): Promise<ArtifactFolder | null> => {
      if (!taskId) return null
      const folder = await foldersCreateMutate({ taskId, ...params })
      if (folder) {
        setFolders((prev) => [...prev, folder])
      }
      return folder
    },
    [taskId, foldersCreateMutate]
  )

  const updateFolder = useCallback(
    async (data: UpdateArtifactFolderInput): Promise<void> => {
      const updated = await foldersUpdateMutate(data)
      if (updated) {
        setFolders((prev) => prev.map((f) => (f.id === data.id ? updated : f)))
      }
    },
    [foldersUpdateMutate]
  )

  const deleteFolder = useCallback(
    async (id: string): Promise<void> => {
      await foldersDeleteMutate({ id })
      setFolders((prev) => prev.filter((f) => f.id !== id))
      // Artifacts in deleted folder get folder_id = NULL (DB handles it), refresh local state
      setArtifacts((prev) => prev.map((a) => (a.folder_id === id ? { ...a, folder_id: null } : a)))
    },
    [foldersDeleteMutate]
  )

  const renameFolder = useCallback(
    async (id: string, newName: string): Promise<void> => {
      const updated = await foldersUpdateMutate({ id, name: newName })
      if (updated) {
        setFolders((prev) => prev.map((f) => (f.id === id ? updated : f)))
      }
    },
    [foldersUpdateMutate]
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
