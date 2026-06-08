import { app, dialog, BrowserWindow, shell } from 'electron'
import path from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, createWriteStream } from 'fs'
import archiver from 'archiver'
import type { SlayzoneDb } from '@slayzone/platform'
import {
  getEffectiveRenderMode,
  canExportAsPdf,
  canExportAsPng,
  canExportAsHtml
} from '@slayzone/task/shared'
import { buildPdfHtml, buildMermaidPdfHtml, buildPngHtml, renderToPdf, renderToPng } from './artifact-export'
import {
  createArtifactStore,
  buildFolderPathResolver,
  collectFolderAndDescendants
} from '../server/artifact-store'

// Electron-only artifact download/export flows (native save/open dialogs + headless
// PDF/PNG rendering). Shared single implementation behind both the IPC handlers
// (./handlers.ts) and the tRPC `artifacts` router (which dynamic-imports this module
// only in the Electron-main host; the standalone @slayzone/server returns
// PRECONDITION_FAILED). `dataDir` is the app data root.

async function getArtifactRow(db: SlayzoneDb, id: string): Promise<Record<string, unknown> | undefined> {
  return (await db.prepare('SELECT * FROM task_artifacts WHERE id = ?').get(id)) as
    | Record<string, unknown>
    | undefined
}

export async function downloadArtifactFile(
  db: SlayzoneDb,
  dataDir: string,
  id: string
): Promise<boolean> {
  const store = createArtifactStore(dataDir)
  const existing = await getArtifactRow(db, id)
  if (!existing) return false
  const srcPath = store.getArtifactFilePath(existing.task_id as string, id, existing.title as string)
  if (!existsSync(srcPath)) return false

  const defaultPath = path.join(app.getPath('downloads'), existing.title as string)
  const win = BrowserWindow.getFocusedWindow()
  const result = win
    ? await dialog.showSaveDialog(win, { title: 'Download Artifact', defaultPath })
    : await dialog.showSaveDialog({ title: 'Download Artifact', defaultPath })
  if (result.canceled || !result.filePath) return false

  copyFileSync(srcPath, result.filePath)
  return true
}

export async function downloadArtifactFolder(
  db: SlayzoneDb,
  dataDir: string,
  folderId: string
): Promise<boolean> {
  const store = createArtifactStore(dataDir)
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

  const allFolders = (await db
    .prepare('SELECT * FROM artifact_folders WHERE task_id = ?')
    .all(taskId)) as Record<string, unknown>[]
  const folderPath = buildFolderPathResolver(allFolders)
  const targetIds = collectFolderAndDescendants(allFolders, folderId)

  const rootFolderPath = folderPath(folderId)
  const rootParentPath = path.dirname(rootFolderPath)

  for (const id of targetIds) {
    const rel =
      rootParentPath === '.' ? folderPath(id) : path.relative(rootParentPath, folderPath(id))
    mkdirSync(path.join(destRoot, rel), { recursive: true })
  }

  const artifacts = (await db
    .prepare(
      'SELECT * FROM task_artifacts WHERE task_id = ? AND folder_id IN (' +
        [...targetIds].map(() => '?').join(',') +
        ')'
    )
    .all(taskId, ...targetIds)) as Record<string, unknown>[]
  for (const artifact of artifacts) {
    const srcPath = store.getArtifactFilePath(taskId, artifact.id as string, artifact.title as string)
    if (!existsSync(srcPath)) continue
    const folderRel =
      rootParentPath === '.'
        ? folderPath(artifact.folder_id as string)
        : path.relative(rootParentPath, folderPath(artifact.folder_id as string))
    copyFileSync(srcPath, path.join(destRoot, folderRel, artifact.title as string))
  }

  return true
}

export async function downloadArtifactAsPdf(
  db: SlayzoneDb,
  dataDir: string,
  id: string
): Promise<boolean> {
  const store = createArtifactStore(dataDir)
  const existing = await getArtifactRow(db, id)
  if (!existing) return false

  const title = existing.title as string
  const mode = getEffectiveRenderMode(title, existing.render_mode as string | null as any)
  if (!canExportAsPdf(mode)) return false

  const srcPath = store.getArtifactFilePath(existing.task_id as string, id, title)
  if (!existsSync(srcPath)) return false
  const content = readFileSync(srcPath, 'utf-8')

  const isMermaid = mode === 'mermaid-preview'
  const html = isMermaid ? buildMermaidPdfHtml(content, title) : buildPdfHtml(content, mode, title)

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
}

export async function downloadArtifactAsPng(
  db: SlayzoneDb,
  dataDir: string,
  id: string
): Promise<boolean> {
  const store = createArtifactStore(dataDir)
  const existing = await getArtifactRow(db, id)
  if (!existing) return false

  const title = existing.title as string
  const mode = getEffectiveRenderMode(title, existing.render_mode as string | null as any)
  if (!canExportAsPng(mode)) return false

  const srcPath = store.getArtifactFilePath(existing.task_id as string, id, title)
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
}

export async function downloadArtifactAsHtml(
  db: SlayzoneDb,
  dataDir: string,
  id: string
): Promise<boolean> {
  const store = createArtifactStore(dataDir)
  const existing = await getArtifactRow(db, id)
  if (!existing) return false

  const title = existing.title as string
  const mode = getEffectiveRenderMode(title, existing.render_mode as string | null as any)
  if (!canExportAsHtml(mode)) return false

  const srcPath = store.getArtifactFilePath(existing.task_id as string, id, title)
  if (!existsSync(srcPath)) return false
  const content = readFileSync(srcPath, 'utf-8')

  const isMermaid = mode === 'mermaid-preview'
  const html = isMermaid ? buildMermaidPdfHtml(content, title) : buildPdfHtml(content, mode, title)

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
}

export async function downloadAllArtifactsAsZip(
  db: SlayzoneDb,
  dataDir: string,
  taskId: string
): Promise<boolean> {
  const store = createArtifactStore(dataDir)
  const allArtifacts = (await db
    .prepare('SELECT * FROM task_artifacts WHERE task_id = ?')
    .all(taskId)) as Record<string, unknown>[]
  if (allArtifacts.length === 0) return false

  const allFolders = (await db
    .prepare('SELECT * FROM artifact_folders WHERE task_id = ?')
    .all(taskId)) as Record<string, unknown>[]
  const folderPath = buildFolderPathResolver(allFolders)

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
    const srcPath = store.getArtifactFilePath(taskId, artifact.id as string, artifact.title as string)
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
}
