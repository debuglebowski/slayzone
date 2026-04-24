import type { IpcMain } from 'electron'
import { app, dialog, BrowserWindow, shell } from 'electron'
import type { Database } from 'better-sqlite3'
import type {
  CreateTaskInput,
  UpdateTaskInput,
  CreateAssetInput,
  UpdateAssetInput,
  TaskAsset,
  RenderMode,
  AssetFolder,
  CreateAssetFolderInput,
  UpdateAssetFolderInput,
} from '@slayzone/task/shared'
import { getExtensionFromTitle, getEffectiveRenderMode, canExportAsPdf, canExportAsPng, canExportAsHtml } from '@slayzone/task/shared'
import path from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, rmSync, copyFileSync, statSync, readdirSync, createWriteStream } from 'fs'
import { randomUUID } from 'crypto'
import archiver from 'archiver'
import { buildPdfHtml, buildMermaidPdfHtml, buildPngHtml, renderToPdf, renderToPng } from './asset-export'
import { startAssetWatcher } from './asset-watcher'
import {
  BlobStore,
  betterSqliteTxn,
  createVersion,
  saveCurrent,
  setCurrentVersion,
  listVersions,
  resolveVersionRef,
  readVersionContent,
  renameVersion,
  pruneVersions,
  diffVersions,
  isVersionError,
} from '@slayzone/task-assets/main'
import type { AuthorContext, VersionRef } from '@slayzone/task-assets/shared'
import {
  addBlockerOp,
  archiveManyTasksOp,
  archiveTaskOp,
  cleanupTaskFull,
  createTaskOp,
  deleteTaskOp,
  getAllBlockedTaskIdsOp,
  getAllTasksOp,
  getArchivedTasksOp,
  getBlockersOp,
  getBlockingOp,
  getByProjectOp,
  getSubTasksOp,
  getSubTasksRecursiveOp,
  getTaskOp,
  loadBoardDataOp,
  removeBlockerOp,
  reorderTasksOp,
  restoreTaskOp,
  setBlockersOp,
  unarchiveTaskOp,
  updateTaskOp,
} from './ops/index.js'

export { configureTaskRuntimeAdapters, updateTask } from './ops/shared.js'
export type { TaskRuntimeAdapters, DiagnosticEventPayload, DiagnosticLevel } from './ops/shared.js'

export function registerTaskHandlers(ipcMain: IpcMain, db: Database, onMutation?: () => void): void {

  // Purge stale soft-deleted tasks from previous sessions
  const stale = db.prepare(
    `SELECT id FROM tasks WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now', '-5 minutes')`
  ).all() as { id: string }[]
  void (async () => {
    for (const { id } of stale) {
      await cleanupTaskFull(db, id)
    }
  })()
  if (stale.length > 0) {
    const placeholders = stale.map(() => '?').join(',')
    db.prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`).run(...stale.map((r) => r.id))
    // Clean up per-task commit graph settings
    for (const { id } of stale) {
      db.prepare(`DELETE FROM settings WHERE key = ?`).run(`commit_graph:task:${id}`)
    }
    console.log(`Purged ${stale.length} soft-deleted task(s)`)
  }

  const deps = { ipcMain, onMutation }

  // Task CRUD
  ipcMain.handle('db:tasks:getAll', () => getAllTasksOp(db))
  ipcMain.handle('db:tasks:getByProject', (_, projectId: string) => getByProjectOp(db, projectId))
  ipcMain.handle('db:tasks:get', (_, id: string) => getTaskOp(db, id))
  ipcMain.handle('db:tasks:create', (_, data: CreateTaskInput) => createTaskOp(db, data, deps))
  ipcMain.handle('db:tasks:getSubTasks', (_, parentId: string) => getSubTasksOp(db, parentId))
  ipcMain.handle('db:tasks:getSubTasksRecursive', (_, rootId: string) => getSubTasksRecursiveOp(db, rootId))
  ipcMain.handle('db:tasks:update', (_, data: UpdateTaskInput) => updateTaskOp(db, data, deps))
  ipcMain.handle('db:tasks:delete', (_, id: string) => deleteTaskOp(db, id, deps))
  ipcMain.handle('db:tasks:restore', (_, id: string) => restoreTaskOp(db, id, deps))
  ipcMain.handle('db:tasks:archive', (_, id: string) => archiveTaskOp(db, id, deps))
  ipcMain.handle('db:tasks:archiveMany', (_, ids: string[]) => archiveManyTasksOp(db, ids, deps))
  ipcMain.handle('db:tasks:unarchive', (_, id: string) => unarchiveTaskOp(db, id, deps))
  ipcMain.handle('db:tasks:getArchived', () => getArchivedTasksOp(db))
  ipcMain.handle('db:tasks:reorder', (_, taskIds: string[]) => reorderTasksOp(db, taskIds))

  // Task Dependencies
  ipcMain.handle('db:taskDependencies:getBlockers', (_, taskId: string) => getBlockersOp(db, taskId))
  ipcMain.handle('db:taskDependencies:getAllBlockedTaskIds', () => getAllBlockedTaskIdsOp(db))
  ipcMain.handle('db:taskDependencies:getBlocking', (_, taskId: string) => getBlockingOp(db, taskId))
  ipcMain.handle(
    'db:taskDependencies:addBlocker',
    (_, taskId: string, blockerTaskId: string) => addBlockerOp(db, taskId, blockerTaskId)
  )
  ipcMain.handle(
    'db:taskDependencies:removeBlocker',
    (_, taskId: string, blockerTaskId: string) => removeBlockerOp(db, taskId, blockerTaskId)
  )
  ipcMain.handle(
    'db:taskDependencies:setBlockers',
    (_, taskId: string, blockerTaskIds: string[]) => setBlockersOp(db, taskId, blockerTaskIds)
  )

  // Batched load for board data — single IPC round-trip instead of 5
  ipcMain.handle('db:loadBoardData', () => loadBoardDataOp(db))

  // --- Task Assets ---

  const dataDir = process.env.SLAYZONE_DB_DIR || app.getPath('userData')
  const assetsDir = path.join(dataDir, 'assets')
  const blobStore = new BlobStore(dataDir)
  const versionTxn = betterSqliteTxn(db)
  const uiAuthor: AuthorContext = { type: 'user', id: null }
  startAssetWatcher(assetsDir)

  function getAssetFilePath(taskId: string, assetId: string, title: string): string {
    const ext = getExtensionFromTitle(title) || '.txt'
    return path.join(assetsDir, taskId, `${assetId}${ext}`)
  }

  function parseAsset(row: Record<string, unknown> | undefined): TaskAsset | null {
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
      current_version_id: (row.current_version_id as string) ?? null,
    }
  }

  function parseFolder(row: Record<string, unknown> | undefined): AssetFolder | null {
    if (!row) return null
    return {
      id: row.id as string,
      task_id: row.task_id as string,
      parent_id: (row.parent_id as string) ?? null,
      name: row.name as string,
      order: row.order as number,
      created_at: row.created_at as string,
    }
  }

  ipcMain.handle('db:assets:getByTask', (_, taskId: string) => {
    const rows = db
      .prepare('SELECT * FROM task_assets WHERE task_id = ? ORDER BY "order" ASC, created_at ASC')
      .all(taskId) as Record<string, unknown>[]
    return rows.map(parseAsset).filter(Boolean)
  })

  ipcMain.handle('db:assets:get', (_, id: string) => {
    const row = db.prepare('SELECT * FROM task_assets WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return parseAsset(row)
  })

  ipcMain.handle('db:assets:create', (_, data: CreateAssetInput) => {
    const id = randomUUID()
    const folderId = data.folderId ?? null
    const maxOrder = (db.prepare(
      folderId
        ? 'SELECT MAX("order") as m FROM task_assets WHERE task_id = ? AND folder_id = ?'
        : 'SELECT MAX("order") as m FROM task_assets WHERE task_id = ? AND folder_id IS NULL'
    ).get(...(folderId ? [data.taskId, folderId] : [data.taskId])) as { m: number | null }).m ?? -1

    db.prepare(`
      INSERT INTO task_assets (id, task_id, folder_id, title, render_mode, language, "order")
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, data.taskId, folderId, data.title, data.renderMode ?? null, data.language ?? null, maxOrder + 1)

    // Write content to disk
    const filePath = getAssetFilePath(data.taskId, id, data.title)
    mkdirSync(path.dirname(filePath), { recursive: true })
    const initialBytes = Buffer.from(data.content ?? '', 'utf-8')
    writeFileSync(filePath, initialBytes)

    // Seed v1 for the new asset.
    createVersion(db, versionTxn, blobStore, { assetId: id, bytes: initialBytes, author: uiAuthor })

    onMutation?.()
    const row = db.prepare('SELECT * FROM task_assets WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return parseAsset(row)
  })

  ipcMain.handle('db:assets:update', (_, data: UpdateAssetInput & { mutateVersion?: boolean }) => {
    const existing = db.prepare('SELECT * FROM task_assets WHERE id = ?').get(data.id) as Record<string, unknown> | undefined
    if (!existing) return null

    const sets: string[] = []
    const values: unknown[] = []
    if (data.title !== undefined) { sets.push('title = ?'); values.push(data.title) }
    if (data.folderId !== undefined) { sets.push('folder_id = ?'); values.push(data.folderId) }
    if (data.renderMode !== undefined) { sets.push('render_mode = ?'); values.push(data.renderMode) }
    if (data.viewMode !== undefined) { sets.push('view_mode = ?'); values.push(data.viewMode) }
    if (data.readabilityOverride !== undefined) { sets.push('readability_override = ?'); values.push(data.readabilityOverride) }
    if (data.widthOverride !== undefined) { sets.push('width_override = ?'); values.push(data.widthOverride) }
    if (data.language !== undefined) { sets.push('language = ?'); values.push(data.language) }
    if (sets.length > 0) {
      sets.push('updated_at = datetime(\'now\')')
      values.push(data.id)
      db.prepare(`UPDATE task_assets SET ${sets.join(', ')} WHERE id = ?`).run(...values)
    }

    // If title changed and extension changed, rename file on disk
    const taskId = existing.task_id as string
    const oldTitle = existing.title as string
    const newTitle = data.title ?? oldTitle
    if (data.title !== undefined) {
      const oldExt = getExtensionFromTitle(oldTitle) || '.txt'
      const newExt = getExtensionFromTitle(newTitle) || '.txt'
      if (oldExt !== newExt) {
        const oldPath = path.join(assetsDir, taskId, `${data.id}${oldExt}`)
        const newPath = path.join(assetsDir, taskId, `${data.id}${newExt}`)
        if (existsSync(oldPath)) {
          const content = readFileSync(oldPath, 'utf-8')
          writeFileSync(newPath, content, 'utf-8')
          unlinkSync(oldPath)
        }
      }
    }

    // UI autosave: `saveCurrent` mutates current in place when mutable
    // (tip + unnamed) or auto-branches when locked. Explicit "Create
    // version" still uses `createVersion` to always create a row.
    if (data.content !== undefined) {
      const filePath = getAssetFilePath(taskId, data.id, newTitle)
      mkdirSync(path.dirname(filePath), { recursive: true })
      const bytes = Buffer.from(data.content, 'utf-8')
      writeFileSync(filePath, bytes)
      if (data.mutateVersion) {
        saveCurrent(db, versionTxn, blobStore, { assetId: data.id, bytes, author: uiAuthor })
      } else {
        createVersion(db, versionTxn, blobStore, { assetId: data.id, bytes, author: uiAuthor })
      }
    }

    onMutation?.()
    const row = db.prepare('SELECT * FROM task_assets WHERE id = ?').get(data.id) as Record<string, unknown> | undefined
    return parseAsset(row)
  })

  ipcMain.handle('db:assets:delete', (_, id: string) => {
    const existing = db.prepare('SELECT * FROM task_assets WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!existing) return false

    const filePath = getAssetFilePath(existing.task_id as string, id, existing.title as string)
    if (existsSync(filePath)) unlinkSync(filePath)

    db.prepare('DELETE FROM task_assets WHERE id = ?').run(id)
    onMutation?.()
    return true
  })

  ipcMain.handle('db:assets:reorder', (_, data: string[] | { folderId: string | null; assetIds: string[] }) => {
    const assetIds = Array.isArray(data) ? data : data.assetIds
    const stmt = db.prepare('UPDATE task_assets SET "order" = ? WHERE id = ?')
    db.transaction(() => {
      assetIds.forEach((id, index) => {
        stmt.run(index, id)
      })
    })()
  })

  ipcMain.handle('db:assets:readContent', (_, id: string) => {
    const existing = db.prepare('SELECT * FROM task_assets WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!existing) return null
    const filePath = getAssetFilePath(existing.task_id as string, id, existing.title as string)
    if (!existsSync(filePath)) return ''
    return readFileSync(filePath, 'utf-8')
  })

  ipcMain.handle('db:assets:getFilePath', (_, id: string) => {
    const existing = db.prepare('SELECT * FROM task_assets WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!existing) return null
    return getAssetFilePath(existing.task_id as string, id, existing.title as string)
  })

  ipcMain.handle('db:assets:getMtime', (_, id: string) => {
    const existing = db.prepare('SELECT * FROM task_assets WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!existing) return null
    const filePath = getAssetFilePath(existing.task_id as string, id, existing.title as string)
    try {
      return statSync(filePath).mtimeMs
    } catch {
      return null
    }
  })

  ipcMain.handle('db:assets:upload', (_, data: { taskId: string; sourcePath: string; title?: string }) => {
    const id = randomUUID()
    const title = data.title ?? path.basename(data.sourcePath)
    const maxOrder = (db.prepare('SELECT MAX("order") as m FROM task_assets WHERE task_id = ?').get(data.taskId) as { m: number | null }).m ?? -1

    db.prepare(`
      INSERT INTO task_assets (id, task_id, title, "order")
      VALUES (?, ?, ?, ?)
    `).run(id, data.taskId, title, maxOrder + 1)

    const filePath = getAssetFilePath(data.taskId, id, title)
    mkdirSync(path.dirname(filePath), { recursive: true })
    copyFileSync(data.sourcePath, filePath)

    // Seed v1 from uploaded bytes.
    createVersion(db, versionTxn, blobStore, {
      assetId: id,
      bytes: readFileSync(filePath),
      author: uiAuthor,
    })

    onMutation?.()
    const row = db.prepare('SELECT * FROM task_assets WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return parseAsset(row)
  })

  ipcMain.handle('db:assets:getFileSize', (_, id: string) => {
    const existing = db.prepare('SELECT * FROM task_assets WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!existing) return null
    const filePath = getAssetFilePath(existing.task_id as string, id, existing.title as string)
    if (!existsSync(filePath)) return null
    return statSync(filePath).size
  })

  ipcMain.handle('db:assets:uploadDir', (_, data: { taskId: string; dirPath: string; parentFolderId: string | null }) => {
    const createdFolders: ReturnType<typeof parseFolder>[] = []
    const createdAssets: ReturnType<typeof parseAsset>[] = []

    function walkDir(dirPath: string, parentFolderId: string | null) {
      const entries = readdirSync(dirPath, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name)
        if (entry.isDirectory()) {
          const folderId = randomUUID()
          const maxOrder = (db.prepare(
            parentFolderId
              ? 'SELECT MAX("order") as m FROM asset_folders WHERE task_id = ? AND parent_id = ?'
              : 'SELECT MAX("order") as m FROM asset_folders WHERE task_id = ? AND parent_id IS NULL'
          ).get(...(parentFolderId ? [data.taskId, parentFolderId] : [data.taskId])) as { m: number | null }).m ?? -1

          db.prepare(`
            INSERT INTO asset_folders (id, task_id, parent_id, name, "order")
            VALUES (?, ?, ?, ?, ?)
          `).run(folderId, data.taskId, parentFolderId, entry.name, maxOrder + 1)

          const row = db.prepare('SELECT * FROM asset_folders WHERE id = ?').get(folderId) as Record<string, unknown> | undefined
          createdFolders.push(parseFolder(row))
          walkDir(fullPath, folderId)
        } else if (entry.isFile()) {
          const assetId = randomUUID()
          const title = entry.name
          const maxOrder = (db.prepare(
            parentFolderId
              ? 'SELECT MAX("order") as m FROM task_assets WHERE task_id = ? AND folder_id = ?'
              : 'SELECT MAX("order") as m FROM task_assets WHERE task_id = ? AND folder_id IS NULL'
          ).get(...(parentFolderId ? [data.taskId, parentFolderId] : [data.taskId])) as { m: number | null }).m ?? -1

          db.prepare(`
            INSERT INTO task_assets (id, task_id, folder_id, title, "order")
            VALUES (?, ?, ?, ?, ?)
          `).run(assetId, data.taskId, parentFolderId, title, maxOrder + 1)

          const filePath = getAssetFilePath(data.taskId, assetId, title)
          mkdirSync(path.dirname(filePath), { recursive: true })
          copyFileSync(fullPath, filePath)

          const row = db.prepare('SELECT * FROM task_assets WHERE id = ?').get(assetId) as Record<string, unknown> | undefined
          createdAssets.push(parseAsset(row))
        }
      }
    }

    db.transaction(() => {
      walkDir(data.dirPath, data.parentFolderId)
    })()

    onMutation?.()
    return { folders: createdFolders.filter(Boolean), assets: createdAssets.filter(Boolean) }
  })

  // Cleanup asset files when a task is permanently deleted
  ipcMain.handle('db:assets:cleanupTask', (_, taskId: string) => {
    const taskDir = path.join(assetsDir, taskId)
    if (existsSync(taskDir)) rmSync(taskDir, { recursive: true, force: true })
  })

  // --- Asset Versions ---

  function wrapVersionError<T>(fn: () => T): T {
    try {
      return fn()
    } catch (err: unknown) {
      if (isVersionError(err)) {
        // Return a serializable error to the renderer.
        throw new Error(`[${err.code}] ${err.message}`)
      }
      throw err
    }
  }

  ipcMain.handle('db:assets:versions:list', (_, data: { assetId: string; limit?: number; offset?: number }) => {
    return listVersions(db, data.assetId, { limit: data.limit, offset: data.offset })
  })

  ipcMain.handle('db:assets:versions:read', (_, data: { assetId: string; versionRef: VersionRef }) => {
    return wrapVersionError(() => {
      const v = resolveVersionRef(db, data.assetId, data.versionRef)
      const buf = readVersionContent(blobStore, v)
      return buf.toString('utf-8')
    })
  })

  ipcMain.handle('db:assets:versions:create', (_, data: { assetId: string; name?: string | null }) => {
    return wrapVersionError(() => {
      const existing = db.prepare('SELECT * FROM task_assets WHERE id = ?').get(data.assetId) as Record<string, unknown> | undefined
      if (!existing) throw new Error('Asset not found')
      const filePath = getAssetFilePath(existing.task_id as string, data.assetId, existing.title as string)
      const bytes = existsSync(filePath) ? readFileSync(filePath) : Buffer.alloc(0)
      return createVersion(db, versionTxn, blobStore, {
        assetId: data.assetId,
        bytes,
        name: data.name ?? null,
        honorUnchanged: true,
        author: uiAuthor,
      })
    })
  })

  ipcMain.handle('db:assets:versions:rename', (_, data: { assetId: string; versionRef: VersionRef; newName: string | null }) => {
    return wrapVersionError(() => renameVersion(db, versionTxn, data.assetId, data.versionRef, data.newName))
  })

  ipcMain.handle('db:assets:versions:diff', (_, data: { assetId: string; a: VersionRef; b?: VersionRef }) => {
    return wrapVersionError(() => diffVersions(db, blobStore, { assetId: data.assetId, a: data.a, b: data.b }))
  })

  ipcMain.handle('db:assets:versions:prune', (_, data: { assetId: string; keepLast?: number; keepNamed?: boolean; keepCurrent?: boolean; dryRun?: boolean }) => {
    return wrapVersionError(() =>
      pruneVersions(db, versionTxn, blobStore, data.assetId, {
        keepLast: data.keepLast,
        keepNamed: data.keepNamed,
        keepCurrent: data.keepCurrent,
        dryRun: data.dryRun,
      })
    )
  })

  ipcMain.handle('db:assets:versions:setCurrent', (_, data: { assetId: string; versionRef: VersionRef }) => {
    return wrapVersionError(() => {
      const existing = db.prepare('SELECT * FROM task_assets WHERE id = ?').get(data.assetId) as Record<string, unknown> | undefined
      if (!existing) throw new Error('Asset not found')
      const v = setCurrentVersion(db, versionTxn, data.assetId, data.versionRef)
      // Flush the switched version's bytes to disk so the editor reloads
      // the correct content. Without this, the on-disk file still reflects
      // the prior current and saves would diff against stale bytes.
      const bytes = readVersionContent(blobStore, v)
      const filePath = getAssetFilePath(existing.task_id as string, data.assetId, existing.title as string)
      mkdirSync(path.dirname(filePath), { recursive: true })
      writeFileSync(filePath, bytes)
      onMutation?.()
      return v
    })
  })

  // --- Asset Download ---

  ipcMain.handle('db:assets:downloadFile', async (_, id: string) => {
    const existing = db.prepare('SELECT * FROM task_assets WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!existing) return false
    const srcPath = getAssetFilePath(existing.task_id as string, id, existing.title as string)
    if (!existsSync(srcPath)) return false

    const defaultPath = path.join(app.getPath('downloads'), existing.title as string)
    const win = BrowserWindow.getFocusedWindow()
    const result = win
      ? await dialog.showSaveDialog(win, { title: 'Download Asset', defaultPath })
      : await dialog.showSaveDialog({ title: 'Download Asset', defaultPath })
    if (result.canceled || !result.filePath) return false

    copyFileSync(srcPath, result.filePath)
    return true
  })

  ipcMain.handle('db:assets:downloadFolder', async (_, folderId: string) => {
    const folder = db.prepare('SELECT * FROM asset_folders WHERE id = ?').get(folderId) as Record<string, unknown> | undefined
    if (!folder) return false

    const win = BrowserWindow.getFocusedWindow()
    const result = win
      ? await dialog.showOpenDialog(win, { title: 'Download Folder To', properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ title: 'Download Folder To', properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || !result.filePaths.length) return false

    const destRoot = result.filePaths[0]
    const taskId = folder.task_id as string

    // Build folder path map: folderId -> name segments
    const allFolders = db.prepare('SELECT * FROM asset_folders WHERE task_id = ?').all(taskId) as Record<string, unknown>[]
    const byId = new Map(allFolders.map(f => [f.id as string, f]))
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
      const rel = rootParentPath === '.' ? folderPath(id) : path.relative(rootParentPath, folderPath(id))
      mkdirSync(path.join(destRoot, rel), { recursive: true })
    }

    // Copy assets in target folders
    const assets = db.prepare('SELECT * FROM task_assets WHERE task_id = ? AND folder_id IN (' + [...targetIds].map(() => '?').join(',') + ')').all(taskId, ...targetIds) as Record<string, unknown>[]
    for (const asset of assets) {
      const srcPath = getAssetFilePath(taskId, asset.id as string, asset.title as string)
      if (!existsSync(srcPath)) continue
      const folderRel = rootParentPath === '.' ? folderPath(asset.folder_id as string) : path.relative(rootParentPath, folderPath(asset.folder_id as string))
      copyFileSync(srcPath, path.join(destRoot, folderRel, asset.title as string))
    }

    return true
  })

  // --- Download as PDF ---

  ipcMain.handle('db:assets:downloadAsPdf', async (_, id: string) => {
    const existing = db.prepare('SELECT * FROM task_assets WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!existing) return false

    const title = existing.title as string
    const mode = getEffectiveRenderMode(title, (existing.render_mode as string | null) as any)
    if (!canExportAsPdf(mode)) return false

    const srcPath = getAssetFilePath(existing.task_id as string, id, title)
    if (!existsSync(srcPath)) return false
    const content = readFileSync(srcPath, 'utf-8')

    const isMermaid = mode === 'mermaid-preview'
    const html = isMermaid ? buildMermaidPdfHtml(content, title) : buildPdfHtml(content, mode, title)

    const baseName = title.replace(/\.[^.]+$/, '') || title
    const defaultPath = path.join(app.getPath('downloads'), `${baseName}.pdf`)
    const win = BrowserWindow.getFocusedWindow()
    const result = win
      ? await dialog.showSaveDialog(win, { title: 'Download as PDF', defaultPath, filters: [{ name: 'PDF', extensions: ['pdf'] }] })
      : await dialog.showSaveDialog({ title: 'Download as PDF', defaultPath, filters: [{ name: 'PDF', extensions: ['pdf'] }] })
    if (result.canceled || !result.filePath) return false

    const pdfBuffer = await renderToPdf(html, isMermaid)
    writeFileSync(result.filePath, pdfBuffer)
    shell.showItemInFolder(result.filePath)
    return true
  })

  // --- Download as PNG ---

  ipcMain.handle('db:assets:downloadAsPng', async (_, id: string) => {
    const existing = db.prepare('SELECT * FROM task_assets WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!existing) return false

    const title = existing.title as string
    const mode = getEffectiveRenderMode(title, (existing.render_mode as string | null) as any)
    if (!canExportAsPng(mode)) return false

    const srcPath = getAssetFilePath(existing.task_id as string, id, title)
    if (!existsSync(srcPath)) return false
    const content = readFileSync(srcPath, 'utf-8')

    const html = buildPngHtml(content, mode, title)
    if (!html) return false

    const baseName = title.replace(/\.[^.]+$/, '') || title
    const defaultPath = path.join(app.getPath('downloads'), `${baseName}.png`)
    const win = BrowserWindow.getFocusedWindow()
    const result = win
      ? await dialog.showSaveDialog(win, { title: 'Download as PNG', defaultPath, filters: [{ name: 'PNG', extensions: ['png'] }] })
      : await dialog.showSaveDialog({ title: 'Download as PNG', defaultPath, filters: [{ name: 'PNG', extensions: ['png'] }] })
    if (result.canceled || !result.filePath) return false

    const pngBuffer = await renderToPng(html)
    writeFileSync(result.filePath, pngBuffer)
    shell.showItemInFolder(result.filePath)
    return true
  })

  // --- Download as HTML ---

  ipcMain.handle('db:assets:downloadAsHtml', async (_, id: string) => {
    const existing = db.prepare('SELECT * FROM task_assets WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!existing) return false

    const title = existing.title as string
    const mode = getEffectiveRenderMode(title, (existing.render_mode as string | null) as any)
    if (!canExportAsHtml(mode)) return false

    const srcPath = getAssetFilePath(existing.task_id as string, id, title)
    if (!existsSync(srcPath)) return false
    const content = readFileSync(srcPath, 'utf-8')

    const isMermaid = mode === 'mermaid-preview'
    const html = isMermaid ? buildMermaidPdfHtml(content, title) : buildPdfHtml(content, mode, title)

    const baseName = title.replace(/\.[^.]+$/, '') || title
    const defaultPath = path.join(app.getPath('downloads'), `${baseName}.html`)
    const win = BrowserWindow.getFocusedWindow()
    const result = win
      ? await dialog.showSaveDialog(win, { title: 'Download as HTML', defaultPath, filters: [{ name: 'HTML', extensions: ['html'] }] })
      : await dialog.showSaveDialog({ title: 'Download as HTML', defaultPath, filters: [{ name: 'HTML', extensions: ['html'] }] })
    if (result.canceled || !result.filePath) return false

    writeFileSync(result.filePath, html, 'utf-8')
    shell.showItemInFolder(result.filePath)
    return true
  })

  // --- Download All as ZIP ---

  ipcMain.handle('db:assets:downloadAllAsZip', async (_, taskId: string) => {
    const allAssets = db.prepare('SELECT * FROM task_assets WHERE task_id = ?').all(taskId) as Record<string, unknown>[]
    if (allAssets.length === 0) return false

    const allFolders = db.prepare('SELECT * FROM asset_folders WHERE task_id = ?').all(taskId) as Record<string, unknown>[]
    const byId = new Map(allFolders.map(f => [f.id as string, f]))
    function folderPath(id: string): string {
      const f = byId.get(id)
      if (!f) return ''
      const parent = f.parent_id as string | null
      return parent ? path.join(folderPath(parent), f.name as string) : (f.name as string)
    }

    const win = BrowserWindow.getFocusedWindow()
    const defaultPath = path.join(app.getPath('downloads'), 'assets.zip')
    const result = win
      ? await dialog.showSaveDialog(win, { title: 'Download All as ZIP', defaultPath, filters: [{ name: 'ZIP', extensions: ['zip'] }] })
      : await dialog.showSaveDialog({ title: 'Download All as ZIP', defaultPath, filters: [{ name: 'ZIP', extensions: ['zip'] }] })
    if (result.canceled || !result.filePath) return false

    const output = createWriteStream(result.filePath)
    const archive = archiver('zip', { zlib: { level: 9 } })
    archive.pipe(output)

    for (const asset of allAssets) {
      const srcPath = getAssetFilePath(taskId, asset.id as string, asset.title as string)
      if (!existsSync(srcPath)) continue
      const folderId = asset.folder_id as string | null
      const rel = folderId ? path.join(folderPath(folderId), asset.title as string) : (asset.title as string)
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

  // --- Asset Folders ---

  ipcMain.handle('db:assetFolders:getByTask', (_, taskId: string) => {
    const rows = db
      .prepare('SELECT * FROM asset_folders WHERE task_id = ? ORDER BY "order" ASC, created_at ASC')
      .all(taskId) as Record<string, unknown>[]
    return rows.map(parseFolder).filter(Boolean)
  })

  ipcMain.handle('db:assetFolders:create', (_, data: CreateAssetFolderInput) => {
    const id = randomUUID()
    const parentId = data.parentId ?? null
    const maxOrder = (db.prepare(
      parentId
        ? 'SELECT MAX("order") as m FROM asset_folders WHERE task_id = ? AND parent_id = ?'
        : 'SELECT MAX("order") as m FROM asset_folders WHERE task_id = ? AND parent_id IS NULL'
    ).get(...(parentId ? [data.taskId, parentId] : [data.taskId])) as { m: number | null }).m ?? -1

    db.prepare(`
      INSERT INTO asset_folders (id, task_id, parent_id, name, "order")
      VALUES (?, ?, ?, ?, ?)
    `).run(id, data.taskId, parentId, data.name, maxOrder + 1)

    onMutation?.()
    const row = db.prepare('SELECT * FROM asset_folders WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return parseFolder(row)
  })

  ipcMain.handle('db:assetFolders:update', (_, data: UpdateAssetFolderInput) => {
    const existing = db.prepare('SELECT * FROM asset_folders WHERE id = ?').get(data.id) as Record<string, unknown> | undefined
    if (!existing) return null

    const sets: string[] = []
    const values: unknown[] = []
    if (data.name !== undefined) { sets.push('name = ?'); values.push(data.name) }
    if (data.parentId !== undefined) { sets.push('parent_id = ?'); values.push(data.parentId) }
    if (sets.length > 0) {
      values.push(data.id)
      db.prepare(`UPDATE asset_folders SET ${sets.join(', ')} WHERE id = ?`).run(...values)
    }

    onMutation?.()
    const row = db.prepare('SELECT * FROM asset_folders WHERE id = ?').get(data.id) as Record<string, unknown> | undefined
    return parseFolder(row)
  })

  ipcMain.handle('db:assetFolders:delete', (_, id: string) => {
    const existing = db.prepare('SELECT * FROM asset_folders WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!existing) return false
    db.prepare('DELETE FROM asset_folders WHERE id = ?').run(id)
    onMutation?.()
    return true
  })

  ipcMain.handle('db:assetFolders:reorder', (_, data: { parentId: string | null; folderIds: string[] }) => {
    const stmt = db.prepare('UPDATE asset_folders SET "order" = ? WHERE id = ?')
    db.transaction(() => {
      data.folderIds.forEach((id, index) => {
        stmt.run(index, id)
      })
    })()
  })
}
