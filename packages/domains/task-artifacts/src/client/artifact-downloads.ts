import { electronBootstrap } from '@slayzone/transport/client'
import type { SaveTargetRequest } from '@slayzone/platform/electron-bootstrap-contract'
import {
  planFolderDownload,
  planTaskDownload,
  safeFileName,
  type DownloadEntry
} from '@slayzone/task-artifacts/download-plan'

/**
 * Artifact downloads on the device the person is using. The client reads each file
 * from the hub in bounded pieces (`artifacts.readBytesChunk`) and streams them into a
 * save target on its own host: desktop writes to disk from Electron main (a zip is
 * compressed there off the UI thread), the web shell saves a browser download (a zip
 * is built in a worker). No piece is larger than {@link DOWNLOAD_CHUNK_BYTES} and at
 * most two are in flight, so neither memory nor any message grows with the file: a
 * download has no size ceiling and the UI stays responsive.
 *
 * A file the hub reports as gone is SKIPPED and listed in the outcome (the caller
 * says so); any other read failure aborts the download — partial output removed —
 * and is thrown. Nothing is ever left out silently.
 */

/** A cleanup step whose failure must not replace the error being reported. */
const ignore = (): void => undefined

/** The size of each piece read from the hub. */
export const DOWNLOAD_CHUNK_BYTES = 4 * 1024 * 1024

/** One piece of an artifact's bytes and its total size; null = no such artifact/file. */
export type ReadArtifactChunk = (
  id: string,
  offset: number,
  length: number
) => Promise<{ data: Uint8Array; size: number } | null>

/** `saved` false = nothing to save or the person cancelled. `skipped`: paths not found. */
export interface DownloadOutcome {
  saved: boolean
  skipped: string[]
}

interface FolderRow {
  id: string
  name: string
  parent_id: string | null
}
interface ArtifactRow {
  id: string
  title: string
  folder_id: string | null
}

class ArtifactGoneError extends Error {
  constructor() {
    super('Artifact file not found')
  }
}

/**
 * The artifact's pieces in order, the next one fetched while this one is written
 * (two reads in flight at most). Throws {@link ArtifactGoneError} before the first
 * piece when the hub has no such file.
 */
async function* pieces(read: ReadArtifactChunk, id: string): AsyncGenerator<Uint8Array> {
  let offset = 0
  let next = read(id, 0, DOWNLOAD_CHUNK_BYTES)
  for (;;) {
    const piece = await next
    if (!piece) {
      if (offset === 0) throw new ArtifactGoneError()
      throw new Error('The artifact changed while it was being downloaded')
    }
    const end = offset + piece.data.byteLength
    const more = piece.data.byteLength > 0 && end < piece.size
    if (more) {
      next = read(id, end, DOWNLOAD_CHUNK_BYTES)
      // Consumed on the next turn; a consumer that stops early must not leave it unhandled.
      next.catch(ignore)
    }
    yield piece.data
    offset = end
    if (!more) return
  }
}

/** Open a target; null when the person cancelled. Throws the host's error. */
async function open(request: SaveTargetRequest): Promise<string | null> {
  const opened = await electronBootstrap.saveTargetOpen(request)
  if (opened.ok) return opened.targetId
  if ('canceled' in opened) return null
  throw new Error(opened.error)
}

async function close(targetId: string): Promise<void> {
  const closed = await electronBootstrap.saveTargetClose(targetId)
  if (!closed.ok) throw new Error('error' in closed ? closed.error : 'Saving was cancelled')
}

/** Stream one artifact into `path` of the target. Gone → false, nothing written. */
async function streamInto(
  targetId: string,
  path: string,
  id: string,
  read: ReadArtifactChunk
): Promise<boolean> {
  const it = pieces(read, id)
  let first: IteratorResult<Uint8Array>
  try {
    first = await it.next()
  } catch (err) {
    if (err instanceof ArtifactGoneError) return false
    throw err
  }
  if (!first.done) await electronBootstrap.saveTargetWrite(targetId, path, first.value)
  for await (const piece of it)
    if (piece.byteLength > 0) await electronBootstrap.saveTargetWrite(targetId, path, piece)
  return true
}

/** Write every entry (and folder) into an open target; abort it on any failure. */
async function fill(
  targetId: string,
  entries: DownloadEntry[],
  dirs: string[],
  read: ReadArtifactChunk
): Promise<DownloadOutcome> {
  const skipped: string[] = []
  const written = (async () => {
    for (const dir of dirs) await electronBootstrap.saveTargetMkdir(targetId, dir)
    for (const e of entries)
      if (!(await streamInto(targetId, e.path, e.artifactId, read))) skipped.push(e.path)
    await close(targetId)
  })()
  return written.then(
    () => ({ saved: true, skipped }),
    async (err: unknown) => {
      await electronBootstrap.saveTargetAbort(targetId).catch(ignore)
      throw err
    }
  )
}

export async function downloadArtifactOnThisDevice(
  artifact: ArtifactRow,
  read: ReadArtifactChunk
): Promise<DownloadOutcome> {
  // Read the first piece before asking where to save: a missing file fails at once.
  const it = pieces(read, artifact.id)
  const first = await it.next()
  const targetId = await open({
    kind: 'file',
    fileName: safeFileName(artifact.title, artifact.id),
    title: 'Download Artifact'
  })
  if (!targetId) {
    await it.return(undefined)
    return { saved: false, skipped: [] }
  }
  const written = (async () => {
    if (!first.done) await electronBootstrap.saveTargetWrite(targetId, '', first.value)
    for await (const piece of it)
      if (piece.byteLength > 0) await electronBootstrap.saveTargetWrite(targetId, '', piece)
    await close(targetId)
  })()
  return written.then(
    () => ({ saved: true, skipped: [] }),
    async (err: unknown) => {
      await electronBootstrap.saveTargetAbort(targetId).catch(ignore)
      throw err
    }
  )
}

export async function downloadFolderOnThisDevice(
  folders: FolderRow[],
  artifacts: ArtifactRow[],
  folderId: string,
  read: ReadArtifactChunk
): Promise<DownloadOutcome> {
  const plan = planFolderDownload(folders, artifacts, folderId)
  if (!plan) return { saved: false, skipped: [] }
  const targetId = await open({
    kind: 'directory',
    folderName: plan.folderName,
    title: 'Download Folder To'
  })
  if (!targetId) return { saved: false, skipped: [] }
  return fill(targetId, plan.entries, plan.dirs, read)
}

export async function downloadTaskZipOnThisDevice(
  folders: FolderRow[],
  artifacts: ArtifactRow[],
  read: ReadArtifactChunk
): Promise<DownloadOutcome> {
  if (artifacts.length === 0) return { saved: false, skipped: [] }
  const targetId = await open({
    kind: 'zip',
    fileName: 'artifacts.zip',
    title: 'Download All as ZIP',
    reveal: true
  })
  if (!targetId) return { saved: false, skipped: [] }
  return fill(targetId, planTaskDownload(folders, artifacts), [], read)
}

/** Base64 (the `readBytesChunk` wire form) → bytes. */
export function base64ToBytes(base64: string): Uint8Array {
  const native = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64
  if (native) return native(base64)
  const bin = atob(base64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
