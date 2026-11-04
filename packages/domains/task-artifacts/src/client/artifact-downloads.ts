import { electronBootstrap } from '@slayzone/transport/client'
import type { HostSaveResult } from '@slayzone/platform/electron-bootstrap-contract'
import {
  planFolderDownload,
  planTaskDownload,
  zipFiles
} from '@slayzone/task-artifacts/download-plan'

/**
 * Artifact downloads on the device the person is using: the client reads the bytes
 * from the hub (`artifacts.readBytes`) and its host saves them — desktop through its
 * own dialogs, the web shell as a browser download. The hub never touches a disk that
 * is not its own, so downloads work the same against a local or a remote hub.
 *
 * Each resolves `true` when saved, `false` when there was nothing to save or the person
 * dismissed the dialog, and throws on a real failure (for the caller's toast).
 */

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

/** Bytes of an artifact's current version; null when it is gone. */
export type ReadArtifactBytes = (id: string) => Promise<Uint8Array | null>

function settle(result: HostSaveResult): boolean {
  if (result.ok) return true
  if ('canceled' in result) return false
  throw new Error(result.error)
}

/** Base64 (the `readBytes` wire form) → bytes. */
export function base64ToBytes(base64: string): Uint8Array {
  const native = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64
  if (native) return native(base64)
  const bin = atob(base64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Read every entry; one whose file is gone is left out, as the hub-side zip always did. */
async function readAll(
  entries: { artifactId: string; path: string }[],
  read: ReadArtifactBytes
): Promise<{ path: string; data: Uint8Array }[]> {
  const files = await Promise.all(
    entries.map(async (e) => {
      const data = await read(e.artifactId)
      return data ? { path: e.path, data } : null
    })
  )
  return files.filter((f): f is { path: string; data: Uint8Array } => f !== null)
}

export async function downloadArtifactOnThisDevice(
  artifact: ArtifactRow,
  read: ReadArtifactBytes
): Promise<boolean> {
  const data = await read(artifact.id)
  if (!data) throw new Error('Artifact file not found')
  return settle(
    await electronBootstrap.saveFile({ fileName: artifact.title, data, title: 'Download Artifact' })
  )
}

export async function downloadFolderOnThisDevice(
  folders: FolderRow[],
  artifacts: ArtifactRow[],
  folderId: string,
  read: ReadArtifactBytes
): Promise<boolean> {
  const plan = planFolderDownload(folders, artifacts, folderId)
  if (!plan) return false
  return settle(
    await electronBootstrap.saveFiles({
      folderName: plan.folderName,
      title: 'Download Folder To',
      dirs: plan.dirs,
      files: await readAll(plan.entries, read)
    })
  )
}

export async function downloadTaskZipOnThisDevice(
  folders: FolderRow[],
  artifacts: ArtifactRow[],
  read: ReadArtifactBytes
): Promise<boolean> {
  if (artifacts.length === 0) return false
  const files = await readAll(planTaskDownload(folders, artifacts), read)
  return settle(
    await electronBootstrap.saveFile({
      fileName: 'artifacts.zip',
      data: zipFiles(files),
      title: 'Download All as ZIP',
      reveal: true
    })
  )
}
