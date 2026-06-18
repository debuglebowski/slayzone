import type { IpcMain } from 'electron'
import { app } from 'electron'
import type { SlayzoneDb } from '@slayzone/platform'
import type {
  CreateTaskInput,
  UpdateTaskInput,
  CreateArtifactInput,
  UpdateArtifactInput,
  CreateArtifactFolderInput,
  UpdateArtifactFolderInput
} from '@slayzone/task/shared'
import path from 'path'
import { startArtifactWatcher } from '../server/artifact-watcher'
import { initArtifactWatcherBroadcast } from './artifact-watcher-broadcast'
import { createArtifactStore } from '../server/artifact-store'
import {
  downloadArtifactFile,
  downloadArtifactFolder,
  downloadArtifactAsPdf,
  downloadArtifactAsPng,
  downloadArtifactAsHtml,
  downloadAllArtifactsAsZip
} from './artifact-downloads'
import {
  addBlockerOp,
  archiveManyTasksOp,
  archiveTaskOp,
  createTaskOp,
  deleteManyTasksOp,
  deleteTaskOp,
  getAllBlockedTaskIdsOp,
  getAllTasksOp,
  getBlockersOp,
  getBlockingOp,
  getByProjectOp,
  getSubTasksOp,
  getTaskOp,
  loadBoardDataOp,
  removeBlockerOp,
  reorderTasksOp,
  reorderPinnedTasksOp,
  setBrowserTabLockedOp,
  restoreTaskOp,
  setBlockersOp,
  unarchiveTaskOp,
  updateManyTasksOp,
  updateTaskOp,
  type UpdateManyTasksInput
} from '../server/ops/index.js'
import { purgeStaleAndOrphanedTasks } from '../server/ops/startup-purge.js'

export { configureTaskRuntimeAdapters, updateTask } from '../server/ops/shared.js'
export type { TaskRuntimeAdapters, DiagnosticEventPayload, DiagnosticLevel } from '../server/ops/shared.js'

export function registerTaskHandlers(
  ipcMain: IpcMain,
  db: SlayzoneDb,
  onMutation?: () => void,
  /** App data root — the host passes its canonical `ensureDataRoot()`, the SAME value
   *  the tRPC artifacts router resolves from `ctx.dataRoot`, so IPC + tRPC artifact file
   *  paths can't silently diverge. Falls back to the legacy env/userData expression only
   *  when unwired (tests / no host). */
  dataRoot?: string
): void {
  // Startup purge (stale soft-deleted + orphaned temp tasks). Logic lives in the
  // electron-free server layer (ops/startup-purge) so it survives this handler's
  // deletion and can be wired into the sidecar/host boot. Fire-and-forget since
  // the DB is an async worker proxy; handler registration below stays synchronous.
  void purgeStaleAndOrphanedTasks(db)

  const deps = { ipcMain, onMutation }

  // Task CRUD
  ipcMain.handle('db:tasks:getAll', () => getAllTasksOp(db))
  ipcMain.handle('db:tasks:getByProject', (_, projectId: string) => getByProjectOp(db, projectId))
  ipcMain.handle('db:tasks:get', (_, id: string) => getTaskOp(db, id))
  ipcMain.handle('db:tasks:create', (_, data: CreateTaskInput) => createTaskOp(db, data, deps))
  ipcMain.handle('db:tasks:getSubTasks', (_, parentId: string) => getSubTasksOp(db, parentId))
  ipcMain.handle('db:tasks:update', (_, data: UpdateTaskInput) => updateTaskOp(db, data, deps))
  ipcMain.handle('db:tasks:updateMany', (_, data: UpdateManyTasksInput) =>
    updateManyTasksOp(db, data, deps)
  )
  ipcMain.handle('db:tasks:delete', (_, id: string) => deleteTaskOp(db, id, deps))
  ipcMain.handle('db:tasks:deleteMany', (_, ids: string[]) => deleteManyTasksOp(db, ids, deps))
  ipcMain.handle('db:tasks:restore', (_, id: string) => restoreTaskOp(db, id, deps))
  ipcMain.handle('db:tasks:archive', (_, id: string) => archiveTaskOp(db, id, deps))
  ipcMain.handle('db:tasks:archiveMany', (_, ids: string[]) => archiveManyTasksOp(db, ids, deps))
  ipcMain.handle('db:tasks:unarchive', (_, id: string) => unarchiveTaskOp(db, id, deps))
  ipcMain.handle('db:tasks:reorder', (_, taskIds: string[]) => reorderTasksOp(db, taskIds))
  ipcMain.handle('db:tasks:reorderPinned', (_, taskIds: string[]) =>
    reorderPinnedTasksOp(db, taskIds)
  )
  ipcMain.handle(
    'db:tasks:setBrowserTabLocked',
    (_, taskId: string, tabId: string, locked: boolean) =>
      setBrowserTabLockedOp(db, taskId, tabId, locked, deps)
  )

  // Task Dependencies
  ipcMain.handle('db:taskDependencies:getBlockers', (_, taskId: string) =>
    getBlockersOp(db, taskId)
  )
  ipcMain.handle('db:taskDependencies:getAllBlockedTaskIds', () => getAllBlockedTaskIdsOp(db))
  ipcMain.handle('db:taskDependencies:getBlocking', (_, taskId: string) =>
    getBlockingOp(db, taskId)
  )
  ipcMain.handle('db:taskDependencies:addBlocker', (_, taskId: string, blockerTaskId: string) =>
    addBlockerOp(db, taskId, blockerTaskId)
  )
  ipcMain.handle('db:taskDependencies:removeBlocker', (_, taskId: string, blockerTaskId: string) =>
    removeBlockerOp(db, taskId, blockerTaskId)
  )
  ipcMain.handle('db:taskDependencies:setBlockers', (_, taskId: string, blockerTaskIds: string[]) =>
    setBlockersOp(db, taskId, blockerTaskIds)
  )

  // Batched load for board data — single IPC round-trip instead of 5
  ipcMain.handle('db:loadBoardData', () => loadBoardDataOp(db))

  // --- Task Artifacts ---
  //
  // CRUD/version/folder logic lives in the electron-free ../server/artifact-store
  // (shared with the tRPC `artifacts` router). These handlers stay registered for
  // renderer coexistence (slice 5 cutover) and own the post-mutation `onMutation`
  // fan-out. The download *dialogs* below stay here — they need Electron `dialog`/
  // `BrowserWindow`/`shell` + the artifact-export renderers.

  const dataDir = dataRoot ?? (process.env.SLAYZONE_DB_DIR || app.getPath('userData'))
  const artifactsDir = path.join(dataDir, 'artifacts')
  // Wire the legacy webContents.send bridge before the watcher emits (order-safe).
  initArtifactWatcherBroadcast()
  startArtifactWatcher(artifactsDir)
  const store = createArtifactStore(dataDir)

  ipcMain.handle('db:artifacts:getByTask', (_, taskId: string) =>
    store.listArtifactsByTask(db, taskId)
  )
  ipcMain.handle('db:artifacts:get', (_, id: string) => store.getArtifact(db, id))
  ipcMain.handle('db:artifacts:create', async (_, data: CreateArtifactInput) => {
    const r = await store.createArtifact(db, data)
    onMutation?.()
    return r
  })
  ipcMain.handle(
    'db:artifacts:update',
    async (_, data: UpdateArtifactInput & { mutateVersion?: boolean }) => {
      const r = await store.updateArtifact(db, data)
      if (r === null) return null
      onMutation?.()
      return r
    }
  )
  ipcMain.handle('db:artifacts:delete', async (_, id: string) => {
    const ok = await store.deleteArtifact(db, id)
    if (ok) onMutation?.()
    return ok
  })
  ipcMain.handle(
    'db:artifacts:reorder',
    (_, data: string[] | { folderId: string | null; artifactIds: string[] }) =>
      store.reorderArtifacts(db, data)
  )
  ipcMain.handle('db:artifacts:readContent', (_, id: string) => store.readArtifactContent(db, id))
  ipcMain.handle('db:artifacts:getFilePath', (_, id: string) => store.getArtifactPath(db, id))
  ipcMain.handle('db:artifacts:getMtime', (_, id: string) => store.getArtifactMtime(db, id))

  ipcMain.handle(
    'db:artifacts:upload',
    async (_, data: { taskId: string; sourcePath: string; title?: string }) => {
      const r = await store.uploadArtifact(db, data)
      onMutation?.()
      return r
    }
  )
  ipcMain.handle(
    'db:artifacts:pasteFiles',
    async (_, data: { sourcePaths: string[]; destTaskId: string; destFolderId: string | null }) => {
      const r = await store.pasteArtifactFiles(db, data)
      onMutation?.()
      return r
    }
  )
  ipcMain.handle(
    'db:artifacts:uploadBlob',
    async (
      _,
      data: { taskId: string; title: string; bytes: Uint8Array; folderId?: string | null }
    ) => {
      const r = await store.uploadArtifactBlob(db, data)
      onMutation?.()
      return r
    }
  )
  ipcMain.handle(
    'db:artifacts:uploadDir',
    async (_, data: { taskId: string; dirPath: string; parentFolderId: string | null }) => {
      const r = await store.uploadArtifactDir(db, data)
      onMutation?.()
      return r
    }
  )

  // Cleanup artifact files when a task is permanently deleted
  ipcMain.handle('db:artifacts:cleanupTask', (_, taskId: string) =>
    store.cleanupTaskArtifacts(taskId)
  )

  // --- Artifact Versions ---
  ipcMain.handle(
    'db:artifacts:versions:list',
    (_, data: { artifactId: string; limit?: number; offset?: number }) =>
      store.listArtifactVersions(db, data)
  )
  ipcMain.handle(
    'db:artifacts:versions:read',
    (_, data: { artifactId: string; versionRef: import('@slayzone/task-artifacts/shared').VersionRef }) =>
      store.readArtifactVersion(db, data)
  )
  ipcMain.handle(
    'db:artifacts:versions:create',
    (_, data: { artifactId: string; name?: string | null }) =>
      store.createArtifactVersion(db, data)
  )
  ipcMain.handle(
    'db:artifacts:versions:rename',
    (
      _,
      data: {
        artifactId: string
        versionRef: import('@slayzone/task-artifacts/shared').VersionRef
        newName: string | null
      }
    ) => store.renameArtifactVersion(db, data)
  )
  ipcMain.handle(
    'db:artifacts:versions:diff',
    (
      _,
      data: {
        artifactId: string
        a: import('@slayzone/task-artifacts/shared').VersionRef
        b?: import('@slayzone/task-artifacts/shared').VersionRef
      }
    ) => store.diffArtifactVersions(db, data)
  )
  ipcMain.handle(
    'db:artifacts:versions:prune',
    (
      _,
      data: {
        artifactId: string
        keepLast?: number
        keepNamed?: boolean
        keepCurrent?: boolean
        dryRun?: boolean
      }
    ) => store.pruneArtifactVersions(db, data)
  )
  ipcMain.handle(
    'db:artifacts:versions:setCurrent',
    async (
      _,
      data: { artifactId: string; versionRef: import('@slayzone/task-artifacts/shared').VersionRef }
    ) => {
      const version = await store.setCurrentArtifactVersion(db, data)
      onMutation?.()
      return version
    }
  )

  // --- Artifact Download (Electron-only: native dialogs + export renderers) ---
  // Logic lives in ./artifact-downloads (shared with the tRPC artifacts router, which
  // dynamic-imports it only in the Electron-main host).

  ipcMain.handle('db:artifacts:downloadFile', (_, id: string) =>
    downloadArtifactFile(db, dataDir, id)
  )
  ipcMain.handle('db:artifacts:downloadFolder', (_, folderId: string) =>
    downloadArtifactFolder(db, dataDir, folderId)
  )
  ipcMain.handle('db:artifacts:downloadAsPdf', (_, id: string) =>
    downloadArtifactAsPdf(db, dataDir, id)
  )
  ipcMain.handle('db:artifacts:downloadAsPng', (_, id: string) =>
    downloadArtifactAsPng(db, dataDir, id)
  )
  ipcMain.handle('db:artifacts:downloadAsHtml', (_, id: string) =>
    downloadArtifactAsHtml(db, dataDir, id)
  )
  ipcMain.handle('db:artifacts:downloadAllAsZip', (_, taskId: string) =>
    downloadAllArtifactsAsZip(db, dataDir, taskId)
  )

  // --- Artifact Folders ---

  ipcMain.handle('db:artifactFolders:getByTask', (_, taskId: string) =>
    store.listFoldersByTask(db, taskId)
  )

  ipcMain.handle(
    'db:artifactFolders:getOrCreateByName',
    async (_, data: { taskId: string; name: string }) => {
      const r = await store.getOrCreateFolderByName(db, data)
      onMutation?.()
      return r
    }
  )

  ipcMain.handle('db:artifactFolders:create', async (_, data: CreateArtifactFolderInput) => {
    const r = await store.createFolder(db, data)
    onMutation?.()
    return r
  })

  ipcMain.handle('db:artifactFolders:update', async (_, data: UpdateArtifactFolderInput) => {
    const r = await store.updateFolder(db, data)
    if (r) onMutation?.()
    return r
  })

  ipcMain.handle('db:artifactFolders:delete', async (_, id: string) => {
    const ok = await store.deleteFolder(db, id)
    if (ok) onMutation?.()
    return ok
  })

  ipcMain.handle(
    'db:artifactFolders:reorder',
    (_, data: { parentId: string | null; folderIds: string[] }) => store.reorderFolders(db, data)
  )
}
