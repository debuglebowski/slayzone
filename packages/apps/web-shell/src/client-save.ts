// The web shell's side of artifact downloads: the browser saves bytes the client read
// from the hub (`artifacts.readBytes`). A browser cannot write into a folder the person
// picks everywhere, so a set of files arrives as one zip, paths kept.
import type {
  HostSaveResult,
  SaveFileRequest,
  SaveFilesRequest
} from '@slayzone/platform/electron-bootstrap-contract'
import { zipFiles } from '@slayzone/task-artifacts/download-plan'
import { saveBlob } from './artifact-export'

const asBlob = (data: Uint8Array, type?: string): Blob =>
  // A view over a SharedArrayBuffer is not a BlobPart; copy into a plain buffer.
  new Blob([new Uint8Array(data)], type ? { type } : undefined)

export async function saveFileInBrowser(request: SaveFileRequest): Promise<HostSaveResult> {
  saveBlob(asBlob(request.data), request.fileName)
  return { ok: true }
}

export async function saveFilesInBrowser(request: SaveFilesRequest): Promise<HostSaveResult> {
  saveBlob(asBlob(zipFiles(request.files), 'application/zip'), `${request.folderName}.zip`)
  return { ok: true }
}
