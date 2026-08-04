import path from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, createWriteStream } from 'fs'
import archiver from 'archiver'
import type { SlayzoneDb } from '@slayzone/platform'
import {
  getEffectiveRenderMode,
  canExportAsPdf,
  canExportAsPng,
  canExportAsHtml,
  type RenderMode
} from '../shared'
import {
  createArtifactStore,
  buildFolderPathResolver,
  collectFolderAndDescendants
} from './artifact-store'

// Artifact download/export flows. Electron-free by construction: the host-only
// steps (save sheet, directory picker, downloads dir, reveal, offscreen PDF/PNG
// render) arrive as `ArtifactDownloadHost`, which the transport layer fills from
// the AppDeps capability bridge.
//
// This file used to pull those in from the electron module directly and live
// under src/electron/. After the slice-9 cutover the tRPC `artifacts` router
// runs in the plain-node side-car, where requiring that module yields the binary
// path as a *string* — so `dialog`/`app`/`BrowserWindow` were all undefined and
// every download died silently. Living under src/server/ puts it under the
// boundary guard (scripts/check-server-electron-free.sh), so re-introducing that
// dependency here fails lint instead of shipping.
//
// HTML building is a host capability rather than local work on purpose:
// buildMermaidPdfHtml resolves mermaid through require.resolve and silently falls
// back to plain-code rendering on a miss, which from the side-car bundle would
// quietly downgrade every mermaid export.
//
// `dataDir` is the app data root.

export type ArtifactDownloadHost = {
  showSaveDialog: (options: unknown) => Promise<{ canceled: boolean; filePath?: string }>
  showOpenDialog: (options: unknown) => Promise<{ canceled: boolean; filePaths: string[] }>
  // Async: these reach the Electron host over the capability bridge, so every
  // call is a round trip even when the underlying host function is synchronous.
  getDownloadsDir: () => Promise<string>
  showItemInFolder: (absPath: string) => void
  buildExportHtml: (content: string, mode: string, title: string) => Promise<string>
  renderPdfToFile: (
    content: string,
    mode: string,
    title: string,
    destPath: string
  ) => Promise<void>
  /** False when the mode has no PNG representation. */
  renderPngToFile: (
    content: string,
    mode: string,
    title: string,
    destPath: string
  ) => Promise<boolean>
}

async function getArtifactRow(db: SlayzoneDb, id: string): Promise<Record<string, unknown> | undefined> {
  return (await db.prepare('SELECT * FROM task_artifacts WHERE id = ?').get(id)) as
    | Record<string, unknown>
    | undefined
}

/** Artifact row + its on-disk source path; null when either is missing. */
async function resolveSource(
  db: SlayzoneDb,
  dataDir: string,
  id: string
): Promise<{ row: Record<string, unknown>; srcPath: string } | null> {
  const store = createArtifactStore(dataDir)
  const row = await getArtifactRow(db, id)
  if (!row) return null
  const srcPath = store.getArtifactFilePath(row.task_id as string, id, row.title as string)
  if (!existsSync(srcPath)) return null
  return { row, srcPath }
}

export async function downloadArtifactFile(
  host: ArtifactDownloadHost,
  db: SlayzoneDb,
  dataDir: string,
  id: string
): Promise<boolean> {
  const src = await resolveSource(db, dataDir, id)
  if (!src) return false

  const defaultPath = path.join(await host.getDownloadsDir(), src.row.title as string)
  const result = await host.showSaveDialog({ title: 'Download Artifact', defaultPath })
  if (result.canceled || !result.filePath) return false

  copyFileSync(src.srcPath, result.filePath)
  return true
}

export async function downloadArtifactFolder(
  host: ArtifactDownloadHost,
  db: SlayzoneDb,
  dataDir: string,
  folderId: string
): Promise<boolean> {
  const store = createArtifactStore(dataDir)
  const folder = (await db.prepare('SELECT * FROM artifact_folders WHERE id = ?').get(
    folderId
  )) as Record<string, unknown> | undefined
  if (!folder) return false

  const result = await host.showOpenDialog({
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

/** Shared prologue for the 3 render-mode exports: content + mode + names. */
async function resolveExportable(
  db: SlayzoneDb,
  dataDir: string,
  id: string,
  canExport: (mode: RenderMode) => boolean
): Promise<{ content: string; mode: RenderMode; title: string; baseName: string } | null> {
  const src = await resolveSource(db, dataDir, id)
  if (!src) return null

  const title = src.row.title as string
  const mode = getEffectiveRenderMode(title, src.row.render_mode as RenderMode | null)
  if (!canExport(mode)) return null

  return {
    content: readFileSync(src.srcPath, 'utf-8'),
    mode,
    title,
    baseName: title.replace(/\.[^.]+$/, '') || title
  }
}

export async function downloadArtifactAsPdf(
  host: ArtifactDownloadHost,
  db: SlayzoneDb,
  dataDir: string,
  id: string
): Promise<boolean> {
  const ex = await resolveExportable(db, dataDir, id, canExportAsPdf)
  if (!ex) return false

  const result = await host.showSaveDialog({
    title: 'Download as PDF',
    defaultPath: path.join(await host.getDownloadsDir(), `${ex.baseName}.pdf`),
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  })
  if (result.canceled || !result.filePath) return false

  await host.renderPdfToFile(ex.content, ex.mode, ex.title, result.filePath)
  host.showItemInFolder(result.filePath)
  return true
}

export async function downloadArtifactAsPng(
  host: ArtifactDownloadHost,
  db: SlayzoneDb,
  dataDir: string,
  id: string
): Promise<boolean> {
  const ex = await resolveExportable(db, dataDir, id, canExportAsPng)
  if (!ex) return false

  const result = await host.showSaveDialog({
    title: 'Download as PNG',
    defaultPath: path.join(await host.getDownloadsDir(), `${ex.baseName}.png`),
    filters: [{ name: 'PNG', extensions: ['png'] }]
  })
  if (result.canceled || !result.filePath) return false

  const rendered = await host.renderPngToFile(ex.content, ex.mode, ex.title, result.filePath)
  if (!rendered) return false
  host.showItemInFolder(result.filePath)
  return true
}

export async function downloadArtifactAsHtml(
  host: ArtifactDownloadHost,
  db: SlayzoneDb,
  dataDir: string,
  id: string
): Promise<boolean> {
  const ex = await resolveExportable(db, dataDir, id, canExportAsHtml)
  if (!ex) return false

  const result = await host.showSaveDialog({
    title: 'Download as HTML',
    defaultPath: path.join(await host.getDownloadsDir(), `${ex.baseName}.html`),
    filters: [{ name: 'HTML', extensions: ['html'] }]
  })
  if (result.canceled || !result.filePath) return false

  writeFileSync(result.filePath, await host.buildExportHtml(ex.content, ex.mode, ex.title), 'utf-8')
  host.showItemInFolder(result.filePath)
  return true
}

export async function downloadAllArtifactsAsZip(
  host: ArtifactDownloadHost,
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

  const result = await host.showSaveDialog({
    title: 'Download All as ZIP',
    defaultPath: path.join(await host.getDownloadsDir(), 'artifacts.zip'),
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

  host.showItemInFolder(result.filePath)
  return true
}
