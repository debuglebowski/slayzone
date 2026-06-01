import type { IpcMain } from 'electron'
import { app, dialog, BrowserWindow, shell } from 'electron'
import type { SlayzoneDb } from '@slayzone/platform'
import type {
  CreateTaskInput,
  UpdateTaskInput,
  CreateArtifactInput,
  UpdateArtifactInput,
  TaskArtifact,
  RenderMode,
  ArtifactFolder,
  CreateArtifactFolderInput,
  UpdateArtifactFolderInput
} from '@slayzone/task/shared'
import {
  getExtensionFromTitle,
  getEffectiveRenderMode,
  canExportAsPdf,
  canExportAsPng,
  canExportAsHtml
} from '@slayzone/task/shared'
import path from 'path'
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  rmSync,
  copyFileSync,
  statSync,
  createWriteStream
} from 'fs'
import archiver from 'archiver'
import {
  buildPdfHtml,
  buildMermaidPdfHtml,
  buildPngHtml,
  renderToPdf,
  renderToPng
} from './artifact-export'
import { startArtifactWatcher } from './artifact-watcher'
import type { VersionRef } from '@slayzone/task-artifacts/shared'
import {
  addBlockerOp,
  archiveManyTasksOp,
  archiveTaskOp,
  cleanupTaskFull,
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
} from './ops/index.js'

export { configureTaskRuntimeAdapters, updateTask } from './ops/shared.js'
export type { TaskRuntimeAdapters, DiagnosticEventPayload, DiagnosticLevel } from './ops/shared.js'

export function registerTaskHandlers(
  ipcMain: IpcMain,
  db: SlayzoneDb,
  onMutation?: () => void
): void {
  // Startup purges run async (fire-and-forget) since the DB is now an async
  // worker proxy. Registration of IPC handlers below stays synchronous.
  void (async () => {
    // Purge stale soft-deleted tasks from previous sessions
    const stale = (await db
      .prepare(
        `SELECT id FROM tasks WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now', '-5 minutes')`
      )
      .all()) as { id: string }[]
    const staleIds = stale.map((r) => r.id)
    for (const { id } of stale) {
      await cleanupTaskFull(db, id, staleIds)
    }
    if (stale.length > 0) {
      const placeholders = stale.map(() => '?').join(',')
      await db
        .prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`)
        .run(...stale.map((r) => r.id))
      console.log(`Purged ${stale.length} soft-deleted task(s)`)
    }

    // Purge orphaned temporary tasks (untouched for >24h AND not present in the
    // persisted tab list). PTY activity does not bump tasks.updated_at, so the
    // time gate alone purges actively-used scratch terminals after a quit/restart
    // (notably auto-update). Cross-checking viewState protects open temp tasks
    // even when their updated_at is stale; the 24h gate still catches true
    // orphans (crash leaks, tabs closed without renderer cleanup).
    const openTaskIds = new Set<string>()
    try {
      const row = (await db.prepare(`SELECT value FROM settings WHERE key = 'viewState'`).get()) as
        | { value: string }
        | undefined
      if (row?.value) {
        const parsed = JSON.parse(row.value) as {
          tabs?: Array<{ type?: string; taskId?: string }>
        }
        for (const tab of parsed.tabs ?? []) {
          if (tab?.type === 'task' && typeof tab.taskId === 'string') openTaskIds.add(tab.taskId)
        }
      }
    } catch (err) {
      console.warn(
        '[task] Failed to read viewState for temp-task cleanup; falling back to time-only purge:',
        err
      )
    }
    const staleTemp = (
      (await db
        .prepare(
          `SELECT id FROM tasks
     WHERE is_temporary = 1
       AND deleted_at IS NULL
       AND updated_at < datetime('now', '-24 hours')`
        )
        .all()) as { id: string }[]
    ).filter(({ id }) => !openTaskIds.has(id))
    const staleTempIds = staleTemp.map((r) => r.id)
    for (const { id } of staleTemp) {
      await cleanupTaskFull(db, id, staleTempIds)
    }
    if (staleTemp.length > 0) {
      const placeholders = staleTemp.map(() => '?').join(',')
      await db
        .prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`)
        .run(...staleTemp.map((r) => r.id))
      console.log(`Purged ${staleTemp.length} stale temporary task(s)`)
    }
  })()

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

  const dataDir = process.env.SLAYZONE_DB_DIR || app.getPath('userData')
  const artifactsDir = path.join(dataDir, 'artifacts')
  startArtifactWatcher(artifactsDir)

  function getArtifactFilePath(taskId: string, artifactId: string, title: string): string {
    const ext = getExtensionFromTitle(title) || '.txt'
    return path.join(artifactsDir, taskId, `${artifactId}${ext}`)
  }

  // Fallback to pre-v127 path for users where the boot-time disk migration
  // silently failed (permission/FS errors). Belt-and-suspenders — read on
  // every miss, don't mutate. Cost: one existsSync per missing-file path.
  function getLegacyArtifactFilePath(taskId: string, artifactId: string, title: string): string {
    const ext = getExtensionFromTitle(title) || '.txt'
    return path.join(dataDir, 'assets', taskId, `${artifactId}${ext}`)
  }

  function parseArtifact(row: Record<string, unknown> | undefined): TaskArtifact | null {
    if (!row) return null
    return {
      id: row.id as string,
      task_id: row.task_id as string,
      folder_id: (row.folder_id as string) ?? null,
      title: row.title as string,
      render_mode: (row.render_mode as RenderMode) ?? null,
      view_mode: (row.view_mode as string) ?? null,
      readability_override: (row.readability_override as 'compact' | 'normal' | null) ?? null,
      width_override: (row.width_override as 'narrow' | 'wide' | null) ?? null,
      language: (row.language as string) ?? null,
      order: row.order as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      current_version_id: (row.current_version_id as string) ?? null
    }
  }

  function parseFolder(row: Record<string, unknown> | undefined): ArtifactFolder | null {
    if (!row) return null
    return {
      id: row.id as string,
      task_id: row.task_id as string,
      parent_id: (row.parent_id as string) ?? null,
      name: row.name as string,
      order: row.order as number,
      created_at: row.created_at as string
    }
  }

  ipcMain.handle('db:artifacts:getByTask', async (_, taskId: string) => {
    const rows = (await db
      .prepare(
        'SELECT * FROM task_artifacts WHERE task_id = ? ORDER BY "order" ASC, created_at ASC'
      )
      .all(taskId)) as Record<string, unknown>[]
    return rows.map(parseArtifact).filter(Boolean)
  })

  ipcMain.handle('db:artifacts:get', async (_, id: string) => {
    const row = (await db.prepare('SELECT * FROM task_artifacts WHERE id = ?').get(id)) as
      | Record<string, unknown>
      | undefined
    return parseArtifact(row)
  })

  ipcMain.handle('db:artifacts:create', async (_, data: CreateArtifactInput) => {
    const row = await db.namedTxn<Record<string, unknown> | undefined>('task-artifacts:create', {
      dataDir,
      taskId: data.taskId,
      folderId: data.folderId ?? null,
      title: data.title,
      renderMode: data.renderMode ?? null,
      language: data.language ?? null,
      content: data.content ?? ''
    })
    onMutation?.()
    return parseArtifact(row)
  })

  ipcMain.handle(
    'db:artifacts:update',
    async (_, data: UpdateArtifactInput & { mutateVersion?: boolean }) => {
      // Mirror the original `data.x !== undefined` checks: only forward keys the
      // caller actually provided so the worker rebuilds the same SET clause.
      const setKeys: string[] = []
      for (const key of [
        'title',
        'folderId',
        'renderMode',
        'viewMode',
        'readabilityOverride',
        'widthOverride',
        'language',
        'content'
      ] as const) {
        if (data[key] !== undefined) setKeys.push(key)
      }
      const row = await db.namedTxn<Record<string, unknown> | null | undefined>(
        'task-artifacts:update',
        {
          dataDir,
          id: data.id,
          mutateVersion: data.mutateVersion,
          title: data.title,
          folderId: data.folderId,
          renderMode: data.renderMode,
          viewMode: data.viewMode,
          readabilityOverride: data.readabilityOverride,
          widthOverride: data.widthOverride,
          language: data.language,
          content: data.content,
          setKeys
        }
      )
      if (row === null) return null
      onMutation?.()
      return parseArtifact(row ?? undefined)
    }
  )

  ipcMain.handle('db:artifacts:delete', async (_, id: string) => {
    const existing = (await db.prepare('SELECT * FROM task_artifacts WHERE id = ?').get(id)) as
      | Record<string, unknown>
      | undefined
    if (!existing) return false

    const filePath = getArtifactFilePath(existing.task_id as string, id, existing.title as string)
    if (existsSync(filePath)) unlinkSync(filePath)

    await db.prepare('DELETE FROM task_artifacts WHERE id = ?').run(id)
    onMutation?.()
    return true
  })

  ipcMain.handle(
    'db:artifacts:reorder',
    async (_, data: string[] | { folderId: string | null; artifactIds: string[] }) => {
      const artifactIds = Array.isArray(data) ? data : data.artifactIds
      await db.batchTxn(
        artifactIds.map((id, index) => ({
          type: 'run',
          sql: 'UPDATE task_artifacts SET "order" = ? WHERE id = ?',
          params: [index, id]
        }))
      )
    }
  )

  ipcMain.handle('db:artifacts:readContent', async (_, id: string) => {
    const existing = (await db.prepare('SELECT * FROM task_artifacts WHERE id = ?').get(id)) as
      | Record<string, unknown>
      | undefined
    if (!existing) return null
    const filePath = getArtifactFilePath(existing.task_id as string, id, existing.title as string)
    if (existsSync(filePath)) return readFileSync(filePath, 'utf-8')
    const legacyPath = getLegacyArtifactFilePath(
      existing.task_id as string,
      id,
      existing.title as string
    )
    if (existsSync(legacyPath)) return readFileSync(legacyPath, 'utf-8')
    return ''
  })

  ipcMain.handle('db:artifacts:getFilePath', async (_, id: string) => {
    const existing = (await db.prepare('SELECT * FROM task_artifacts WHERE id = ?').get(id)) as
      | Record<string, unknown>
      | undefined
    if (!existing) return null
    return getArtifactFilePath(existing.task_id as string, id, existing.title as string)
  })

  ipcMain.handle('db:artifacts:getMtime', async (_, id: string) => {
    const existing = (await db.prepare('SELECT * FROM task_artifacts WHERE id = ?').get(id)) as
      | Record<string, unknown>
      | undefined
    if (!existing) return null
    const filePath = getArtifactFilePath(existing.task_id as string, id, existing.title as string)
    try {
      return statSync(filePath).mtimeMs
    } catch {
      return null
    }
  })

  ipcMain.handle(
    'db:artifacts:upload',
    async (_, data: { taskId: string; sourcePath: string; title?: string }) => {
      const row = await db.namedTxn<Record<string, unknown> | undefined>('task-artifacts:upload', {
        dataDir,
        taskId: data.taskId,
        sourcePath: data.sourcePath,
        title: data.title ?? path.basename(data.sourcePath)
      })
      onMutation?.()
      return parseArtifact(row)
    }
  )

  ipcMain.handle(
    'db:artifacts:pasteFiles',
    async (_, data: { sourcePaths: string[]; destTaskId: string; destFolderId: string | null }) => {
      const rows = await db.namedTxn<Record<string, unknown>[]>('task-artifacts:pasteFiles', {
        dataDir,
        sourcePaths: data.sourcePaths,
        destTaskId: data.destTaskId,
        destFolderId: data.destFolderId
      })
      onMutation?.()
      return rows.map(parseArtifact).filter(Boolean) as TaskArtifact[]
    }
  )

  ipcMain.handle(
    'db:artifacts:uploadBlob',
    async (
      _,
      data: { taskId: string; title: string; bytes: Uint8Array; folderId?: string | null }
    ): Promise<TaskArtifact | null> => {
      const row = await db.namedTxn<Record<string, unknown> | undefined>(
        'task-artifacts:uploadBlob',
        {
          dataDir,
          taskId: data.taskId,
          title: data.title,
          bytes: data.bytes,
          folderId: data.folderId ?? null
        }
      )
      onMutation?.()
      return parseArtifact(row)
    }
  )

  ipcMain.handle(
    'db:artifacts:uploadDir',
    async (_, data: { taskId: string; dirPath: string; parentFolderId: string | null }) => {
      const result = await db.namedTxn<{
        folders: (Record<string, unknown> | undefined)[]
        artifacts: (Record<string, unknown> | undefined)[]
      }>('task-artifacts:uploadDir', {
        dataDir,
        taskId: data.taskId,
        dirPath: data.dirPath,
        parentFolderId: data.parentFolderId
      })

      onMutation?.()
      return {
        folders: result.folders.map(parseFolder).filter(Boolean),
        artifacts: result.artifacts.map(parseArtifact).filter(Boolean)
      }
    }
  )

  // Cleanup artifact files when a task is permanently deleted
  ipcMain.handle('db:artifacts:cleanupTask', (_, taskId: string) => {
    const taskDir = path.join(artifactsDir, taskId)
    if (existsSync(taskDir)) rmSync(taskDir, { recursive: true, force: true })
  })

  // --- Artifact Versions ---
  //
  // The `@slayzone/task-artifacts` version helpers operate on a synchronous
  // better-sqlite3 db + `TxnRunner`, so they run inside the DB worker via
  // `namedTxn` (see ./artifacts-txns). Each named txn re-formats `VersionError`
  // into a serializable `[CODE] message` string before it crosses the worker
  // boundary, preserving the renderer-facing error contract.

  ipcMain.handle(
    'db:artifacts:versions:list',
    (_, data: { artifactId: string; limit?: number; offset?: number }) => {
      return db.namedTxn('task-artifacts:versions:list', {
        artifactId: data.artifactId,
        limit: data.limit,
        offset: data.offset
      })
    }
  )

  ipcMain.handle(
    'db:artifacts:versions:read',
    (_, data: { artifactId: string; versionRef: VersionRef }) => {
      return db.namedTxn('task-artifacts:versions:read', {
        dataDir,
        artifactId: data.artifactId,
        versionRef: data.versionRef
      })
    }
  )

  ipcMain.handle(
    'db:artifacts:versions:create',
    (_, data: { artifactId: string; name?: string | null }) => {
      return db.namedTxn('task-artifacts:versions:create', {
        dataDir,
        artifactId: data.artifactId,
        name: data.name ?? null
      })
    }
  )

  ipcMain.handle(
    'db:artifacts:versions:rename',
    (_, data: { artifactId: string; versionRef: VersionRef; newName: string | null }) => {
      return db.namedTxn('task-artifacts:versions:rename', {
        artifactId: data.artifactId,
        versionRef: data.versionRef,
        newName: data.newName
      })
    }
  )

  ipcMain.handle(
    'db:artifacts:versions:diff',
    (_, data: { artifactId: string; a: VersionRef; b?: VersionRef }) => {
      return db.namedTxn('task-artifacts:versions:diff', {
        dataDir,
        artifactId: data.artifactId,
        a: data.a,
        b: data.b
      })
    }
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
    ) => {
      return db.namedTxn('task-artifacts:versions:prune', {
        dataDir,
        artifactId: data.artifactId,
        keepLast: data.keepLast,
        keepNamed: data.keepNamed,
        keepCurrent: data.keepCurrent,
        dryRun: data.dryRun
      })
    }
  )

  ipcMain.handle(
    'db:artifacts:versions:setCurrent',
    async (_, data: { artifactId: string; versionRef: VersionRef }) => {
      // The worker switches the current pointer AND flushes the version's bytes
      // back to the artifact's on-disk file; it returns the version row.
      const result = await db.namedTxn<{ version: unknown }>('task-artifacts:versions:setCurrent', {
        dataDir,
        artifactId: data.artifactId,
        versionRef: data.versionRef
      })
      onMutation?.()
      return result.version
    }
  )

  // --- Artifact Download ---

  ipcMain.handle('db:artifacts:downloadFile', async (_, id: string) => {
    const existing = (await db.prepare('SELECT * FROM task_artifacts WHERE id = ?').get(id)) as
      | Record<string, unknown>
      | undefined
    if (!existing) return false
    const srcPath = getArtifactFilePath(existing.task_id as string, id, existing.title as string)
    if (!existsSync(srcPath)) return false

    const defaultPath = path.join(app.getPath('downloads'), existing.title as string)
    const win = BrowserWindow.getFocusedWindow()
    const result = win
      ? await dialog.showSaveDialog(win, { title: 'Download Artifact', defaultPath })
      : await dialog.showSaveDialog({ title: 'Download Artifact', defaultPath })
    if (result.canceled || !result.filePath) return false

    copyFileSync(srcPath, result.filePath)
    return true
  })

  ipcMain.handle('db:artifacts:downloadFolder', async (_, folderId: string) => {
    const folder = (await db.prepare('SELECT * FROM artifact_folders WHERE id = ?').get(
      folderId
    )) as Record<string, unknown> | undefined
    if (!folder) return false

    const win = BrowserWindow.getFocusedWindow()
    const result = win
      ? await dialog.showOpenDialog(win, {
          title: 'Download Folder To',
          properties: ['openDirectory', 'createDirectory']
        })
      : await dialog.showOpenDialog({
          title: 'Download Folder To',
          properties: ['openDirectory', 'createDirectory']
        })
    if (result.canceled || !result.filePaths.length) return false

    const destRoot = result.filePaths[0]
    const taskId = folder.task_id as string

    // Build folder path map: folderId -> name segments
    const allFolders = (await db
      .prepare('SELECT * FROM artifact_folders WHERE task_id = ?')
      .all(taskId)) as Record<string, unknown>[]
    const byId = new Map(allFolders.map((f) => [f.id as string, f]))
    function folderPath(id: string): string {
      const f = byId.get(id)
      if (!f) return ''
      const parent = f.parent_id as string | null
      return parent ? path.join(folderPath(parent), f.name as string) : (f.name as string)
    }

    // Collect target folder ids (folderId + all descendants)
    const targetIds = new Set<string>([folderId])
    let changed = true
    while (changed) {
      changed = false
      for (const f of allFolders) {
        const id = f.id as string
        const parentId = f.parent_id as string | null
        if (parentId && targetIds.has(parentId) && !targetIds.has(id)) {
          targetIds.add(id)
          changed = true
        }
      }
    }

    // Compute relative path from the target folder's parent
    const rootFolderPath = folderPath(folderId)
    const rootParentPath = path.dirname(rootFolderPath)

    // Create all subdirectories
    for (const id of targetIds) {
      const rel =
        rootParentPath === '.' ? folderPath(id) : path.relative(rootParentPath, folderPath(id))
      mkdirSync(path.join(destRoot, rel), { recursive: true })
    }

    // Copy artifacts in target folders
    const artifacts = (await db
      .prepare(
        'SELECT * FROM task_artifacts WHERE task_id = ? AND folder_id IN (' +
          [...targetIds].map(() => '?').join(',') +
          ')'
      )
      .all(taskId, ...targetIds)) as Record<string, unknown>[]
    for (const artifact of artifacts) {
      const srcPath = getArtifactFilePath(taskId, artifact.id as string, artifact.title as string)
      if (!existsSync(srcPath)) continue
      const folderRel =
        rootParentPath === '.'
          ? folderPath(artifact.folder_id as string)
          : path.relative(rootParentPath, folderPath(artifact.folder_id as string))
      copyFileSync(srcPath, path.join(destRoot, folderRel, artifact.title as string))
    }

    return true
  })

  // --- Download as PDF ---

  ipcMain.handle('db:artifacts:downloadAsPdf', async (_, id: string) => {
    const existing = (await db.prepare('SELECT * FROM task_artifacts WHERE id = ?').get(id)) as
      | Record<string, unknown>
      | undefined
    if (!existing) return false

    const title = existing.title as string
    const mode = getEffectiveRenderMode(title, existing.render_mode as string | null as any)
    if (!canExportAsPdf(mode)) return false

    const srcPath = getArtifactFilePath(existing.task_id as string, id, title)
    if (!existsSync(srcPath)) return false
    const content = readFileSync(srcPath, 'utf-8')

    const isMermaid = mode === 'mermaid-preview'
    const html = isMermaid
      ? buildMermaidPdfHtml(content, title)
      : buildPdfHtml(content, mode, title)

    const baseName = title.replace(/\.[^.]+$/, '') || title
    const defaultPath = path.join(app.getPath('downloads'), `${baseName}.pdf`)
    const win = BrowserWindow.getFocusedWindow()
    const result = win
      ? await dialog.showSaveDialog(win, {
          title: 'Download as PDF',
          defaultPath,
          filters: [{ name: 'PDF', extensions: ['pdf'] }]
        })
      : await dialog.showSaveDialog({
          title: 'Download as PDF',
          defaultPath,
          filters: [{ name: 'PDF', extensions: ['pdf'] }]
        })
    if (result.canceled || !result.filePath) return false

    const pdfBuffer = await renderToPdf(html, isMermaid)
    writeFileSync(result.filePath, pdfBuffer)
    shell.showItemInFolder(result.filePath)
    return true
  })

  // --- Download as PNG ---

  ipcMain.handle('db:artifacts:downloadAsPng', async (_, id: string) => {
    const existing = (await db.prepare('SELECT * FROM task_artifacts WHERE id = ?').get(id)) as
      | Record<string, unknown>
      | undefined
    if (!existing) return false

    const title = existing.title as string
    const mode = getEffectiveRenderMode(title, existing.render_mode as string | null as any)
    if (!canExportAsPng(mode)) return false

    const srcPath = getArtifactFilePath(existing.task_id as string, id, title)
    if (!existsSync(srcPath)) return false
    const content = readFileSync(srcPath, 'utf-8')

    const html = buildPngHtml(content, mode, title)
    if (!html) return false

    const baseName = title.replace(/\.[^.]+$/, '') || title
    const defaultPath = path.join(app.getPath('downloads'), `${baseName}.png`)
    const win = BrowserWindow.getFocusedWindow()
    const result = win
      ? await dialog.showSaveDialog(win, {
          title: 'Download as PNG',
          defaultPath,
          filters: [{ name: 'PNG', extensions: ['png'] }]
        })
      : await dialog.showSaveDialog({
          title: 'Download as PNG',
          defaultPath,
          filters: [{ name: 'PNG', extensions: ['png'] }]
        })
    if (result.canceled || !result.filePath) return false

    const pngBuffer = await renderToPng(html)
    writeFileSync(result.filePath, pngBuffer)
    shell.showItemInFolder(result.filePath)
    return true
  })

  // --- Download as HTML ---

  ipcMain.handle('db:artifacts:downloadAsHtml', async (_, id: string) => {
    const existing = (await db.prepare('SELECT * FROM task_artifacts WHERE id = ?').get(id)) as
      | Record<string, unknown>
      | undefined
    if (!existing) return false

    const title = existing.title as string
    const mode = getEffectiveRenderMode(title, existing.render_mode as string | null as any)
    if (!canExportAsHtml(mode)) return false

    const srcPath = getArtifactFilePath(existing.task_id as string, id, title)
    if (!existsSync(srcPath)) return false
    const content = readFileSync(srcPath, 'utf-8')

    const isMermaid = mode === 'mermaid-preview'
    const html = isMermaid
      ? buildMermaidPdfHtml(content, title)
      : buildPdfHtml(content, mode, title)

    const baseName = title.replace(/\.[^.]+$/, '') || title
    const defaultPath = path.join(app.getPath('downloads'), `${baseName}.html`)
    const win = BrowserWindow.getFocusedWindow()
    const result = win
      ? await dialog.showSaveDialog(win, {
          title: 'Download as HTML',
          defaultPath,
          filters: [{ name: 'HTML', extensions: ['html'] }]
        })
      : await dialog.showSaveDialog({
          title: 'Download as HTML',
          defaultPath,
          filters: [{ name: 'HTML', extensions: ['html'] }]
        })
    if (result.canceled || !result.filePath) return false

    writeFileSync(result.filePath, html, 'utf-8')
    shell.showItemInFolder(result.filePath)
    return true
  })

  // --- Download All as ZIP ---

  ipcMain.handle('db:artifacts:downloadAllAsZip', async (_, taskId: string) => {
    const allArtifacts = (await db
      .prepare('SELECT * FROM task_artifacts WHERE task_id = ?')
      .all(taskId)) as Record<string, unknown>[]
    if (allArtifacts.length === 0) return false

    const allFolders = (await db
      .prepare('SELECT * FROM artifact_folders WHERE task_id = ?')
      .all(taskId)) as Record<string, unknown>[]
    const byId = new Map(allFolders.map((f) => [f.id as string, f]))
    function folderPath(id: string): string {
      const f = byId.get(id)
      if (!f) return ''
      const parent = f.parent_id as string | null
      return parent ? path.join(folderPath(parent), f.name as string) : (f.name as string)
    }

    const win = BrowserWindow.getFocusedWindow()
    const defaultPath = path.join(app.getPath('downloads'), 'artifacts.zip')
    const result = win
      ? await dialog.showSaveDialog(win, {
          title: 'Download All as ZIP',
          defaultPath,
          filters: [{ name: 'ZIP', extensions: ['zip'] }]
        })
      : await dialog.showSaveDialog({
          title: 'Download All as ZIP',
          defaultPath,
          filters: [{ name: 'ZIP', extensions: ['zip'] }]
        })
    if (result.canceled || !result.filePath) return false

    const output = createWriteStream(result.filePath)
    const archive = archiver('zip', { zlib: { level: 9 } })
    archive.pipe(output)

    for (const artifact of allArtifacts) {
      const srcPath = getArtifactFilePath(taskId, artifact.id as string, artifact.title as string)
      if (!existsSync(srcPath)) continue
      const folderId = artifact.folder_id as string | null
      const rel = folderId
        ? path.join(folderPath(folderId), artifact.title as string)
        : (artifact.title as string)
      archive.file(srcPath, { name: rel })
    }

    await archive.finalize()
    await new Promise<void>((resolve, reject) => {
      output.on('close', resolve)
      output.on('error', reject)
    })

    shell.showItemInFolder(result.filePath)
    return true
  })

  // --- Artifact Folders ---

  ipcMain.handle('db:artifactFolders:getByTask', async (_, taskId: string) => {
    const rows = (await db
      .prepare(
        'SELECT * FROM artifact_folders WHERE task_id = ? ORDER BY "order" ASC, created_at ASC'
      )
      .all(taskId)) as Record<string, unknown>[]
    return rows.map(parseFolder).filter(Boolean)
  })

  ipcMain.handle(
    'db:artifactFolders:getOrCreateByName',
    async (_, data: { taskId: string; name: string }) => {
      const row = await db.namedTxn<Record<string, unknown> | undefined>(
        'task-artifacts:folders:getOrCreateByName',
        { taskId: data.taskId, name: data.name }
      )
      onMutation?.()
      return parseFolder(row)
    }
  )

  ipcMain.handle('db:artifactFolders:create', async (_, data: CreateArtifactFolderInput) => {
    const row = await db.namedTxn<Record<string, unknown> | undefined>(
      'task-artifacts:folders:create',
      { taskId: data.taskId, parentId: data.parentId ?? null, name: data.name }
    )
    onMutation?.()
    return parseFolder(row)
  })

  ipcMain.handle('db:artifactFolders:update', async (_, data: UpdateArtifactFolderInput) => {
    const existing = (await db.prepare('SELECT * FROM artifact_folders WHERE id = ?').get(
      data.id
    )) as Record<string, unknown> | undefined
    if (!existing) return null

    const sets: string[] = []
    const values: unknown[] = []
    if (data.name !== undefined) {
      sets.push('name = ?')
      values.push(data.name)
    }
    if (data.parentId !== undefined) {
      sets.push('parent_id = ?')
      values.push(data.parentId)
    }
    if (sets.length > 0) {
      values.push(data.id)
      await db.prepare(`UPDATE artifact_folders SET ${sets.join(', ')} WHERE id = ?`).run(...values)
    }

    onMutation?.()
    const row = (await db.prepare('SELECT * FROM artifact_folders WHERE id = ?').get(data.id)) as
      | Record<string, unknown>
      | undefined
    return parseFolder(row)
  })

  ipcMain.handle('db:artifactFolders:delete', async (_, id: string) => {
    const existing = (await db.prepare('SELECT * FROM artifact_folders WHERE id = ?').get(id)) as
      | Record<string, unknown>
      | undefined
    if (!existing) return false
    await db.prepare('DELETE FROM artifact_folders WHERE id = ?').run(id)
    onMutation?.()
    return true
  })

  ipcMain.handle(
    'db:artifactFolders:reorder',
    async (_, data: { parentId: string | null; folderIds: string[] }) => {
      await db.batchTxn(
        data.folderIds.map((id, index) => ({
          type: 'run',
          sql: 'UPDATE artifact_folders SET "order" = ? WHERE id = ?',
          params: [index, id]
        }))
      )
    }
  )
}
