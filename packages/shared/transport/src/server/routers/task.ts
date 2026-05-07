import { z } from 'zod'
import { observable } from '@trpc/server/observable'
import { TRPCError } from '@trpc/server'
import {
  archiveTaskOp,
  archiveManyTasksOp,
  createTaskOp,
  deleteTaskOp,
  restoreTaskOp,
  unarchiveTaskOp,
  updateTaskOp,
  taskEvents,
  listArtifactsByTask,
  getArtifact,
  createArtifact,
  updateArtifact,
  deleteArtifact,
  reorderArtifacts,
  readArtifactContent,
  getArtifactPath,
  getArtifactMtime,
  uploadArtifact,
  uploadArtifactBlob,
  pasteArtifactFiles,
  uploadArtifactDir,
  cleanupTaskArtifacts,
  listArtifactVersions,
  readArtifactVersion,
  createArtifactVersion,
  renameArtifactVersion,
  diffArtifactVersions,
  pruneArtifactVersions,
  setCurrentArtifactVersion,
  listFoldersByTask,
  createFolder,
  updateFolder,
  deleteFolder,
  reorderFolders,
  artifactWatcherEvents,
  listTemplatesByProject,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  setDefaultTemplate,
} from '@slayzone/task/server'
import {
  addBlockerOp,
  deleteManyTasksOp,
  getAllBlockedTaskIdsOp,
  getAllTasksOp,
  getBlockersOp,
  getBlockingOp,
  getByProjectOp,
  getSubTasksOp,
  getSubTasksRecursiveOp,
  getTaskOp,
  loadBoardDataOp,
  removeBlockerOp,
  reorderTasksOp,
  setBlockersOp,
  updateManyTasksOp,
} from '@slayzone/task/server/ops'
import type { CreateTaskInput, UpdateTaskInput, CreateArtifactInput, UpdateArtifactInput, CreateArtifactFolderInput, UpdateArtifactFolderInput, CreateTaskTemplateInput, UpdateTaskTemplateInput } from '@slayzone/task/shared'
import type { VersionRef } from '@slayzone/task-artifacts/shared'
import { router, publicProcedure } from '../trpc'

const createInput = z.unknown() as unknown as z.ZodType<CreateTaskInput>
const updateInput = z.unknown() as unknown as z.ZodType<UpdateTaskInput>
const createArtifactInput = z.unknown() as unknown as z.ZodType<CreateArtifactInput>
const updateArtifactInput = z.unknown() as unknown as z.ZodType<UpdateArtifactInput & { mutateVersion?: boolean }>
const createFolderInput = z.unknown() as unknown as z.ZodType<CreateArtifactFolderInput>
const updateFolderInput = z.unknown() as unknown as z.ZodType<UpdateArtifactFolderInput>
const versionRefInput = z.unknown() as unknown as z.ZodType<VersionRef>
const createTemplateInput = z.unknown() as unknown as z.ZodType<CreateTaskTemplateInput>
const updateTemplateInput = z.unknown() as unknown as z.ZodType<UpdateTaskTemplateInput>

async function tryElectron(): Promise<typeof import('electron') | null> {
  try { return await import('electron') } catch { return null }
}
async function tryArtifactExport(): Promise<typeof import('@slayzone/task/electron/artifact-export') | null> {
  try { return await import('@slayzone/task/electron/artifact-export') } catch { return null }
}

export const taskRouter = router({
  getAll: publicProcedure.query(({ ctx }) => getAllTasksOp(ctx.db)),
  getByProject: publicProcedure.input(z.object({ projectId: z.string() })).query(({ ctx, input }) => getByProjectOp(ctx.db, input.projectId)),
  get: publicProcedure.input(z.object({ id: z.string() })).query(({ ctx, input }) => getTaskOp(ctx.db, input.id)),
  create: publicProcedure.input(createInput).mutation(async ({ ctx, input }) => {
    const r = await createTaskOp(ctx.db, input, {})
    if (!r) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'createTaskOp returned null' })
    return r
  }),
  getSubTasks: publicProcedure.input(z.object({ parentId: z.string() })).query(({ ctx, input }) => getSubTasksOp(ctx.db, input.parentId)),
  getSubTasksRecursive: publicProcedure.input(z.object({ rootId: z.string() })).query(({ ctx, input }) => getSubTasksRecursiveOp(ctx.db, input.rootId)),
  update: publicProcedure.input(updateInput).mutation(async ({ ctx, input }) => {
    const r = await updateTaskOp(ctx.db, input, {})
    if (!r) throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' })
    return r
  }),
  updateMany: publicProcedure.input(z.unknown()).mutation(({ ctx, input }) => updateManyTasksOp(ctx.db, input as never, {})),
  delete: publicProcedure.input(z.object({ id: z.string() })).mutation(({ ctx, input }) => deleteTaskOp(ctx.db, input.id, {})),
  deleteMany: publicProcedure.input(z.object({ ids: z.array(z.string()) })).mutation(({ ctx, input }) => deleteManyTasksOp(ctx.db, input.ids, {})),
  restore: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const r = await restoreTaskOp(ctx.db, input.id, {})
    if (!r) throw new TRPCError({ code: 'NOT_FOUND' })
    return r
  }),
  archive: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const r = await archiveTaskOp(ctx.db, input.id, {})
    if (!r) throw new TRPCError({ code: 'NOT_FOUND' })
    return r
  }),
  archiveMany: publicProcedure.input(z.object({ ids: z.array(z.string()) })).mutation(({ ctx, input }) => archiveManyTasksOp(ctx.db, input.ids, {})),
  unarchive: publicProcedure.input(z.object({ id: z.string() })).mutation(({ ctx, input }) => {
    const r = unarchiveTaskOp(ctx.db, input.id, {})
    if (!r) throw new TRPCError({ code: 'NOT_FOUND' })
    return r
  }),
  reorder: publicProcedure.input(z.object({ taskIds: z.array(z.string()) })).mutation(({ ctx, input }) => reorderTasksOp(ctx.db, input.taskIds)),

  getBlockers: publicProcedure.input(z.object({ taskId: z.string() })).query(({ ctx, input }) => getBlockersOp(ctx.db, input.taskId)),
  getAllBlockedTaskIds: publicProcedure.query(({ ctx }) => getAllBlockedTaskIdsOp(ctx.db)),
  getBlocking: publicProcedure.input(z.object({ taskId: z.string() })).query(({ ctx, input }) => getBlockingOp(ctx.db, input.taskId)),
  addBlocker: publicProcedure.input(z.object({ taskId: z.string(), blockerTaskId: z.string() })).mutation(({ ctx, input }) => addBlockerOp(ctx.db, input.taskId, input.blockerTaskId)),
  removeBlocker: publicProcedure.input(z.object({ taskId: z.string(), blockerTaskId: z.string() })).mutation(({ ctx, input }) => removeBlockerOp(ctx.db, input.taskId, input.blockerTaskId)),
  setBlockers: publicProcedure.input(z.object({ taskId: z.string(), blockerTaskIds: z.array(z.string()) })).mutation(({ ctx, input }) => setBlockersOp(ctx.db, input.taskId, input.blockerTaskIds)),

  loadBoardData: publicProcedure.query(({ ctx }) => loadBoardDataOp(ctx.db)),

  // Artifacts
  artifactsGetByTask: publicProcedure.input(z.object({ taskId: z.string() })).query(({ ctx, input }) => listArtifactsByTask(ctx.db, input.taskId)),
  artifactsGet: publicProcedure.input(z.object({ id: z.string() })).query(({ ctx, input }) => getArtifact(ctx.db, input.id)),
  artifactsCreate: publicProcedure.input(createArtifactInput).mutation(({ ctx, input }) => createArtifact(ctx.db, input)),
  artifactsUpdate: publicProcedure.input(updateArtifactInput).mutation(({ ctx, input }) => updateArtifact(ctx.db, input)),
  artifactsDelete: publicProcedure.input(z.object({ id: z.string() })).mutation(({ ctx, input }) => deleteArtifact(ctx.db, input.id)),
  artifactsReorder: publicProcedure.input(z.unknown()).mutation(({ ctx, input }) => reorderArtifacts(ctx.db, input as never)),
  artifactsReadContent: publicProcedure.input(z.object({ id: z.string() })).query(({ ctx, input }) => readArtifactContent(ctx.db, input.id)),
  artifactsGetFilePath: publicProcedure.input(z.object({ id: z.string() })).query(({ ctx, input }) => getArtifactPath(ctx.db, input.id)),
  artifactsGetMtime: publicProcedure.input(z.object({ id: z.string() })).query(({ ctx, input }) => getArtifactMtime(ctx.db, input.id)),
  artifactsUpload: publicProcedure.input(z.unknown()).mutation(({ ctx, input }) => uploadArtifact(ctx.db, input as never)),
  artifactsUploadBlob: publicProcedure.input(z.unknown()).mutation(({ ctx, input }) => uploadArtifactBlob(ctx.db, input as never)),
  artifactsPasteFiles: publicProcedure.input(z.unknown()).mutation(({ ctx, input }) => pasteArtifactFiles(ctx.db, input as never)),
  artifactsUploadDir: publicProcedure.input(z.unknown()).mutation(({ ctx, input }) => uploadArtifactDir(ctx.db, input as never)),
  artifactsCleanupTask: publicProcedure.input(z.object({ taskId: z.string() })).mutation(({ input }) => { cleanupTaskArtifacts(input.taskId) }),

  // Versions
  versionsList: publicProcedure.input(z.object({ artifactId: z.string(), limit: z.number().optional(), offset: z.number().optional() }))
    .query(({ ctx, input }) => listArtifactVersions(ctx.db, input.artifactId, { limit: input.limit, offset: input.offset })),
  versionsRead: publicProcedure.input(z.object({ artifactId: z.string(), versionRef: versionRefInput }))
    .query(({ ctx, input }) => readArtifactVersion(ctx.db, input.artifactId, input.versionRef)),
  versionsCreate: publicProcedure.input(z.object({ artifactId: z.string(), name: z.string().nullable().optional() }))
    .mutation(({ ctx, input }) => createArtifactVersion(ctx.db, input.artifactId, input.name)),
  versionsRename: publicProcedure.input(z.object({ artifactId: z.string(), versionRef: versionRefInput, newName: z.string().nullable() }))
    .mutation(({ ctx, input }) => renameArtifactVersion(ctx.db, input.artifactId, input.versionRef, input.newName)),
  versionsDiff: publicProcedure.input(z.object({ artifactId: z.string(), a: versionRefInput, b: versionRefInput.optional() }))
    .query(({ ctx, input }) => diffArtifactVersions(ctx.db, input.artifactId, input.a, input.b)),
  versionsPrune: publicProcedure.input(z.object({ artifactId: z.string(), keepLast: z.number().optional(), keepNamed: z.boolean().optional(), keepCurrent: z.boolean().optional(), dryRun: z.boolean().optional() }))
    .mutation(({ ctx, input }) => pruneArtifactVersions(ctx.db, input.artifactId, input)),
  versionsSetCurrent: publicProcedure.input(z.object({ artifactId: z.string(), versionRef: versionRefInput }))
    .mutation(({ ctx, input }) => setCurrentArtifactVersion(ctx.db, input.artifactId, input.versionRef)),

  // Folders
  foldersGetByTask: publicProcedure.input(z.object({ taskId: z.string() })).query(({ ctx, input }) => listFoldersByTask(ctx.db, input.taskId)),
  foldersCreate: publicProcedure.input(createFolderInput).mutation(({ ctx, input }) => createFolder(ctx.db, input)),
  foldersUpdate: publicProcedure.input(updateFolderInput).mutation(({ ctx, input }) => updateFolder(ctx.db, input)),
  foldersDelete: publicProcedure.input(z.object({ id: z.string() })).mutation(({ ctx, input }) => deleteFolder(ctx.db, input.id)),
  foldersReorder: publicProcedure.input(z.object({ parentId: z.string().nullable(), folderIds: z.array(z.string()) }))
    .mutation(({ ctx, input }) => reorderFolders(ctx.db, input)),

  // Templates
  templatesGetByProject: publicProcedure.input(z.object({ projectId: z.string() })).query(({ ctx, input }) => listTemplatesByProject(ctx.db, input.projectId)),
  templatesGet: publicProcedure.input(z.object({ id: z.string() })).query(({ ctx, input }) => getTemplate(ctx.db, input.id)),
  templatesCreate: publicProcedure.input(createTemplateInput).mutation(({ ctx, input }) => createTemplate(ctx.db, input)),
  templatesUpdate: publicProcedure.input(updateTemplateInput).mutation(({ ctx, input }) => updateTemplate(ctx.db, input)),
  templatesDelete: publicProcedure.input(z.object({ id: z.string() })).mutation(({ ctx, input }) => deleteTemplate(ctx.db, input.id)),
  templatesSetDefault: publicProcedure
    .input(z.object({ projectId: z.string(), templateId: z.string().nullable() }))
    .mutation(({ ctx, input }) => { setDefaultTemplate(ctx.db, input.projectId, input.templateId) }),

  // Subscriptions
  onChanged: publicProcedure.subscription(() =>
    observable<void>((emit) => {
      const handler = (): void => emit.next()
      const events = ['task:created', 'task:archived', 'task:unarchived', 'task:updated', 'task:deleted', 'task:restored', 'task:tag-changed'] as const
      for (const e of events) taskEvents.on(e, handler)
      return () => { for (const e of events) taskEvents.off(e, handler) }
    }),
  ),
  artifactsOnContentChanged: publicProcedure.subscription(() =>
    observable<string>((emit) => {
      const handler = (artifactId: string): void => emit.next(artifactId)
      artifactWatcherEvents.on('content-changed', handler)
      return () => artifactWatcherEvents.off('content-changed', handler)
    }),
  ),

  // Electron-only download dialogs
  artifactsDownloadFile: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const electron = await tryElectron()
    if (!electron) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Electron-only' })
    const path = await import('node:path')
    const fs = await import('node:fs')
    const existing = ctx.db.prepare('SELECT * FROM task_artifacts WHERE id = ?').get(input.id) as Record<string, unknown> | undefined
    if (!existing) return false
    const srcPath = getArtifactPath(ctx.db, input.id)
    if (!srcPath || !fs.existsSync(srcPath)) return false
    const defaultPath = path.join(electron.app.getPath('downloads'), existing.title as string)
    const win = electron.BrowserWindow.getFocusedWindow()
    const result = win
      ? await electron.dialog.showSaveDialog(win, { title: 'Download Artifact', defaultPath })
      : await electron.dialog.showSaveDialog({ title: 'Download Artifact', defaultPath })
    if (result.canceled || !result.filePath) return false
    fs.copyFileSync(srcPath, result.filePath)
    return true
  }),
  artifactsDownloadFolder: publicProcedure.input(z.object({ folderId: z.string() })).mutation(async ({ ctx, input }) => {
    const electron = await tryElectron()
    if (!electron) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Electron-only' })
    const path = await import('node:path')
    const fs = await import('node:fs')
    const folder = ctx.db.prepare('SELECT * FROM artifact_folders WHERE id = ?').get(input.folderId) as Record<string, unknown> | undefined
    if (!folder) return false
    const win = electron.BrowserWindow.getFocusedWindow()
    const result = win
      ? await electron.dialog.showOpenDialog(win, { title: 'Download Folder To', properties: ['openDirectory', 'createDirectory'] })
      : await electron.dialog.showOpenDialog({ title: 'Download Folder To', properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || !result.filePaths.length) return false
    const destRoot = result.filePaths[0]
    const taskId = folder.task_id as string
    const allFolders = ctx.db.prepare('SELECT * FROM artifact_folders WHERE task_id = ?').all(taskId) as Record<string, unknown>[]
    const byId = new Map(allFolders.map(f => [f.id as string, f]))
    function folderPath(id: string): string {
      const f = byId.get(id)
      if (!f) return ''
      const parent = f.parent_id as string | null
      return parent ? path.join(folderPath(parent), f.name as string) : (f.name as string)
    }
    const targetIds = new Set<string>([input.folderId])
    let changed = true
    while (changed) {
      changed = false
      for (const f of allFolders) {
        const id = f.id as string
        const parentId = f.parent_id as string | null
        if (parentId && targetIds.has(parentId) && !targetIds.has(id)) { targetIds.add(id); changed = true }
      }
    }
    const rootFolderPath = folderPath(input.folderId)
    const rootParentPath = path.dirname(rootFolderPath)
    for (const id of targetIds) {
      const rel = rootParentPath === '.' ? folderPath(id) : path.relative(rootParentPath, folderPath(id))
      fs.mkdirSync(path.join(destRoot, rel), { recursive: true })
    }
    const artifacts = ctx.db.prepare('SELECT * FROM task_artifacts WHERE task_id = ? AND folder_id IN (' + [...targetIds].map(() => '?').join(',') + ')').all(taskId, ...targetIds) as Record<string, unknown>[]
    for (const artifact of artifacts) {
      const srcPath = getArtifactPath(ctx.db, artifact.id as string)
      if (!srcPath || !fs.existsSync(srcPath)) continue
      const folderRel = rootParentPath === '.' ? folderPath(artifact.folder_id as string) : path.relative(rootParentPath, folderPath(artifact.folder_id as string))
      fs.copyFileSync(srcPath, path.join(destRoot, folderRel, artifact.title as string))
    }
    return true
  }),
  artifactsDownloadAsPdf: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const electron = await tryElectron()
    const exporter = await tryArtifactExport()
    if (!electron || !exporter) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Electron-only' })
    const path = await import('node:path')
    const fs = await import('node:fs')
    const { getEffectiveRenderMode, canExportAsPdf } = await import('@slayzone/task/shared')
    const existing = ctx.db.prepare('SELECT * FROM task_artifacts WHERE id = ?').get(input.id) as Record<string, unknown> | undefined
    if (!existing) return false
    const title = existing.title as string
    const mode = getEffectiveRenderMode(title, (existing.render_mode as string | null) as never)
    if (!canExportAsPdf(mode)) return false
    const srcPath = getArtifactPath(ctx.db, input.id)
    if (!srcPath || !fs.existsSync(srcPath)) return false
    const content = fs.readFileSync(srcPath, 'utf-8')
    const isMermaid = mode === 'mermaid-preview'
    const html = isMermaid ? exporter.buildMermaidPdfHtml(content, title) : exporter.buildPdfHtml(content, mode, title)
    const baseName = title.replace(/\.[^.]+$/, '') || title
    const defaultPath = path.join(electron.app.getPath('downloads'), `${baseName}.pdf`)
    const win = electron.BrowserWindow.getFocusedWindow()
    const result = win
      ? await electron.dialog.showSaveDialog(win, { title: 'Download as PDF', defaultPath, filters: [{ name: 'PDF', extensions: ['pdf'] }] })
      : await electron.dialog.showSaveDialog({ title: 'Download as PDF', defaultPath, filters: [{ name: 'PDF', extensions: ['pdf'] }] })
    if (result.canceled || !result.filePath) return false
    const pdfBuffer = await exporter.renderToPdf(html, isMermaid)
    fs.writeFileSync(result.filePath, pdfBuffer)
    electron.shell.showItemInFolder(result.filePath)
    return true
  }),
  artifactsDownloadAsPng: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const electron = await tryElectron()
    const exporter = await tryArtifactExport()
    if (!electron || !exporter) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Electron-only' })
    const path = await import('node:path')
    const fs = await import('node:fs')
    const { getEffectiveRenderMode, canExportAsPng } = await import('@slayzone/task/shared')
    const existing = ctx.db.prepare('SELECT * FROM task_artifacts WHERE id = ?').get(input.id) as Record<string, unknown> | undefined
    if (!existing) return false
    const title = existing.title as string
    const mode = getEffectiveRenderMode(title, (existing.render_mode as string | null) as never)
    if (!canExportAsPng(mode)) return false
    const srcPath = getArtifactPath(ctx.db, input.id)
    if (!srcPath || !fs.existsSync(srcPath)) return false
    const content = fs.readFileSync(srcPath, 'utf-8')
    const html = exporter.buildPngHtml(content, mode, title)
    if (!html) return false
    const baseName = title.replace(/\.[^.]+$/, '') || title
    const defaultPath = path.join(electron.app.getPath('downloads'), `${baseName}.png`)
    const win = electron.BrowserWindow.getFocusedWindow()
    const result = win
      ? await electron.dialog.showSaveDialog(win, { title: 'Download as PNG', defaultPath, filters: [{ name: 'PNG', extensions: ['png'] }] })
      : await electron.dialog.showSaveDialog({ title: 'Download as PNG', defaultPath, filters: [{ name: 'PNG', extensions: ['png'] }] })
    if (result.canceled || !result.filePath) return false
    const pngBuffer = await exporter.renderToPng(html)
    fs.writeFileSync(result.filePath, pngBuffer)
    electron.shell.showItemInFolder(result.filePath)
    return true
  }),
  artifactsDownloadAsHtml: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const electron = await tryElectron()
    const exporter = await tryArtifactExport()
    if (!electron || !exporter) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Electron-only' })
    const path = await import('node:path')
    const fs = await import('node:fs')
    const { getEffectiveRenderMode, canExportAsHtml } = await import('@slayzone/task/shared')
    const existing = ctx.db.prepare('SELECT * FROM task_artifacts WHERE id = ?').get(input.id) as Record<string, unknown> | undefined
    if (!existing) return false
    const title = existing.title as string
    const mode = getEffectiveRenderMode(title, (existing.render_mode as string | null) as never)
    if (!canExportAsHtml(mode)) return false
    const srcPath = getArtifactPath(ctx.db, input.id)
    if (!srcPath || !fs.existsSync(srcPath)) return false
    const content = fs.readFileSync(srcPath, 'utf-8')
    const isMermaid = mode === 'mermaid-preview'
    const html = isMermaid ? exporter.buildMermaidPdfHtml(content, title) : exporter.buildPdfHtml(content, mode, title)
    const baseName = title.replace(/\.[^.]+$/, '') || title
    const defaultPath = path.join(electron.app.getPath('downloads'), `${baseName}.html`)
    const win = electron.BrowserWindow.getFocusedWindow()
    const result = win
      ? await electron.dialog.showSaveDialog(win, { title: 'Download as HTML', defaultPath, filters: [{ name: 'HTML', extensions: ['html'] }] })
      : await electron.dialog.showSaveDialog({ title: 'Download as HTML', defaultPath, filters: [{ name: 'HTML', extensions: ['html'] }] })
    if (result.canceled || !result.filePath) return false
    fs.writeFileSync(result.filePath, html, 'utf-8')
    electron.shell.showItemInFolder(result.filePath)
    return true
  }),
  artifactsDownloadAllAsZip: publicProcedure.input(z.object({ taskId: z.string() })).mutation(async ({ ctx, input }) => {
    const electron = await tryElectron()
    if (!electron) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Electron-only' })
    const path = await import('node:path')
    const fs = await import('node:fs')
    const archiverMod = await import('archiver')
    const archiver = (archiverMod as unknown as { default: typeof import('archiver') }).default ?? archiverMod
    const allArtifacts = ctx.db.prepare('SELECT * FROM task_artifacts WHERE task_id = ?').all(input.taskId) as Record<string, unknown>[]
    if (allArtifacts.length === 0) return false
    const allFolders = ctx.db.prepare('SELECT * FROM artifact_folders WHERE task_id = ?').all(input.taskId) as Record<string, unknown>[]
    const byId = new Map(allFolders.map(f => [f.id as string, f]))
    function folderPath(id: string): string {
      const f = byId.get(id)
      if (!f) return ''
      const parent = f.parent_id as string | null
      return parent ? path.join(folderPath(parent), f.name as string) : (f.name as string)
    }
    const win = electron.BrowserWindow.getFocusedWindow()
    const defaultPath = path.join(electron.app.getPath('downloads'), 'artifacts.zip')
    const result = win
      ? await electron.dialog.showSaveDialog(win, { title: 'Download All as ZIP', defaultPath, filters: [{ name: 'ZIP', extensions: ['zip'] }] })
      : await electron.dialog.showSaveDialog({ title: 'Download All as ZIP', defaultPath, filters: [{ name: 'ZIP', extensions: ['zip'] }] })
    if (result.canceled || !result.filePath) return false
    const output = fs.createWriteStream(result.filePath)
    const archive = (archiver as unknown as (format: string, opts?: unknown) => { pipe: (s: unknown) => void; file: (path: string, opts: { name: string }) => void; finalize: () => Promise<void> })('zip', { zlib: { level: 9 } })
    archive.pipe(output)
    for (const artifact of allArtifacts) {
      const srcPath = getArtifactPath(ctx.db, artifact.id as string)
      if (!srcPath || !fs.existsSync(srcPath)) continue
      const folderId = artifact.folder_id as string | null
      const rel = folderId ? path.join(folderPath(folderId), artifact.title as string) : (artifact.title as string)
      archive.file(srcPath, { name: rel })
    }
    await archive.finalize()
    await new Promise<void>((resolve, reject) => {
      output.on('close', resolve)
      output.on('error', reject)
    })
    electron.shell.showItemInFolder(result.filePath)
    return true
  }),
})
