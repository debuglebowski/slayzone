import path from 'path'
import { existsSync, mkdirSync, writeFileSync, copyFileSync, createWriteStream } from 'fs'
import { ZipArchive } from 'archiver'
import type { SlayzoneDb } from '@slayzone/platform'
import { containedPath } from '@slayzone/platform/safe-path'
import { buildFolderPathResolver, collectFolderAndDescendants } from './artifact-folder-tree'
import { artifactFilePathIn, artifactsDirOf } from './artifact-paths'

// Artifact file/folder/zip downloads. Electron-free by construction: the host-only
// steps (save sheet, directory picker, downloads dir, reveal) arrive as
// `ArtifactDownloadHost`, which the transport layer fills from the AppDeps capability
// bridge. PDF/PNG/HTML export is NOT here: the client renders those on its own device
// (`exportArtifactOnThisDevice` in @slayzone/task-artifacts/client).
//
// This file used to pull those in from the electron module directly and live
// under src/electron/. After the slice-9 cutover the tRPC `artifacts` router
// runs in the plain-node side-car, where requiring that module yields the binary
// path as a *string* — so `dialog`/`app`/`BrowserWindow` were all undefined and
// every download died silently. Living under src/server/ puts it under the
// boundary guard (scripts/check-server-electron-free.sh), so re-introducing that
// dependency here fails lint instead of shipping.
//
// `dataDir` is the app data root.

export type ArtifactDownloadHost = {
  showSaveDialog: (options: unknown) => Promise<{ canceled: boolean; filePath?: string }>
  showOpenDialog: (options: unknown) => Promise<{ canceled: boolean; filePaths: string[] }>
  // Async: these reach the Electron host over the capability bridge, so every
  // call is a round trip even when the underlying host function is synchronous.
  getDownloadsDir: () => Promise<string>
  showItemInFolder: (absPath: string) => void
}

export interface ArtifactDownloadSource {
  get(id: string): Promise<Record<string, unknown> | undefined>
  folder(id: string): Promise<Record<string, unknown> | undefined>
  artifacts(taskId: string): Promise<Record<string, unknown>[]>
  folders(taskId: string): Promise<Record<string, unknown>[]>
  read(id: string): Promise<Uint8Array>
}

async function getArtifactRow(
  db: SlayzoneDb,
  id: string
): Promise<Record<string, unknown> | undefined> {
  return (await db.prepare('SELECT * FROM task_artifacts WHERE id = ?').get(id)) as
    | Record<string, unknown>
    | undefined
}

/** Artifact row + its on-disk source path; null when either is missing. */
async function resolveSource(
  db: SlayzoneDb,
  dataDir: string,
  id: string,
  source?: ArtifactDownloadSource
): Promise<{ row: Record<string, unknown>; srcPath?: string; bytes?: Uint8Array } | null> {
  if (source) {
    const row = await source.get(id)
    return row ? { row, bytes: await source.read(id) } : null
  }
  const artifactsDir = artifactsDirOf(dataDir)
  const row = await getArtifactRow(db, id)
  if (!row) return null
  const srcPath = artifactFilePathIn(artifactsDir, row.task_id as string, id, row.title as string)
  if (!existsSync(srcPath)) return null
  return { row, srcPath }
}

export async function downloadArtifactFile(
  host: ArtifactDownloadHost,
  db: SlayzoneDb,
  dataDir: string,
  id: string,
  source?: ArtifactDownloadSource
): Promise<boolean> {
  const src = await resolveSource(db, dataDir, id, source)
  if (!src) return false

  const defaultPath = path.join(await host.getDownloadsDir(), src.row.title as string)
  const result = await host.showSaveDialog({ title: 'Download Artifact', defaultPath })
  if (result.canceled || !result.filePath) return false

  if (src.bytes) writeFileSync(result.filePath, src.bytes)
  else if (src.srcPath) copyFileSync(src.srcPath, result.filePath)
  return true
}

export async function downloadArtifactFolder(
  host: ArtifactDownloadHost,
  db: SlayzoneDb,
  dataDir: string,
  folderId: string,
  source?: ArtifactDownloadSource
): Promise<boolean> {
  const artifactsDir = artifactsDirOf(dataDir)
  const folder = (
    source
      ? await source.folder(folderId)
      : await db.prepare('SELECT * FROM artifact_folders WHERE id = ?').get(folderId)
  ) as Record<string, unknown> | undefined
  if (!folder) return false

  const result = await host.showOpenDialog({
    title: 'Download Folder To',
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || !result.filePaths.length) return false

  const destRoot = result.filePaths[0]
  const taskId = folder.task_id as string

  const allFolders = (
    source
      ? await source.folders(taskId)
      : await db.prepare('SELECT * FROM artifact_folders WHERE task_id = ?').all(taskId)
  ) as Record<string, unknown>[]
  const folderPath = buildFolderPathResolver(allFolders)
  const targetIds = collectFolderAndDescendants(allFolders, folderId)

  const rootFolderPath = folderPath(folderId)
  const rootParentPath = path.dirname(rootFolderPath)

  // Folder names and titles are free text (an agent can name an artifact `../../.zshrc`):
  // every write stays inside the chosen directory, or the download is refused.
  for (const id of targetIds) {
    const rel =
      rootParentPath === '.' ? folderPath(id) : path.relative(rootParentPath, folderPath(id))
    // '' = destRoot itself (an unnamed folder), which the user picked and exists.
    if (rel) mkdirSync(containedPath(destRoot, rel), { recursive: true })
  }

  const artifacts = (
    source
      ? (await source.artifacts(taskId)).filter((a) => targetIds.has(String(a.folder_id)))
      : await db
          .prepare(
            'SELECT * FROM task_artifacts WHERE task_id = ? AND folder_id IN (' +
              [...targetIds].map(() => '?').join(',') +
              ')'
          )
          .all(taskId, ...targetIds)
  ) as Record<string, unknown>[]
  for (const artifact of artifacts) {
    const srcPath = artifactFilePathIn(
      artifactsDir,
      taskId,
      artifact.id as string,
      artifact.title as string
    )
    if (!source && !existsSync(srcPath)) continue
    const folderRel =
      rootParentPath === '.'
        ? folderPath(artifact.folder_id as string)
        : path.relative(rootParentPath, folderPath(artifact.folder_id as string))
    const destination = containedPath(destRoot, folderRel, artifact.title as string)
    if (source) writeFileSync(destination, await source.read(String(artifact.id)))
    else copyFileSync(srcPath, destination)
  }

  return true
}

export async function downloadAllArtifactsAsZip(
  host: ArtifactDownloadHost,
  db: SlayzoneDb,
  dataDir: string,
  taskId: string,
  source?: ArtifactDownloadSource
): Promise<boolean> {
  const artifactsDir = artifactsDirOf(dataDir)
  const allArtifacts = (
    source
      ? await source.artifacts(taskId)
      : await db.prepare('SELECT * FROM task_artifacts WHERE task_id = ?').all(taskId)
  ) as Record<string, unknown>[]
  if (allArtifacts.length === 0) return false

  const allFolders = (
    source
      ? await source.folders(taskId)
      : await db.prepare('SELECT * FROM artifact_folders WHERE task_id = ?').all(taskId)
  ) as Record<string, unknown>[]
  const folderPath = buildFolderPathResolver(allFolders)

  const result = await host.showSaveDialog({
    title: 'Download All as ZIP',
    defaultPath: path.join(await host.getDownloadsDir(), 'artifacts.zip'),
    filters: [{ name: 'ZIP', extensions: ['zip'] }]
  })
  if (result.canceled || !result.filePath) return false

  const output = createWriteStream(result.filePath)
  const archive = new ZipArchive({ zlib: { level: 9 } })
  archive.pipe(output)

  for (const artifact of allArtifacts) {
    const srcPath = artifactFilePathIn(
      artifactsDir,
      taskId,
      artifact.id as string,
      artifact.title as string
    )
    if (!source && !existsSync(srcPath)) continue
    const folderId = artifact.folder_id as string | null
    const rel = folderId
      ? path.join(folderPath(folderId), artifact.title as string)
      : (artifact.title as string)
    if (source) archive.append(Buffer.from(await source.read(String(artifact.id))), { name: rel })
    else archive.file(srcPath, { name: rel })
  }

  const done = new Promise<void>((resolve, reject) => {
    output.on('close', resolve)
    output.on('error', reject)
    archive.on('error', reject)
  })
  await archive.finalize()
  await done

  host.showItemInFolder(result.filePath)
  return true
}
