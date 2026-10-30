/**
 * Upload a file from the phone as a new artifact of a task, on the hub that owns the
 * task. The bytes go as the raw request body of `POST /api/artifacts?taskId=&title=
 * [&folderId=]` — the hub's binary-safe create (`slay tasks artifacts create` uses it),
 * streamed from disk by the OS (`File.upload`, never read into JS) — so a photo arrives
 * byte-exact. Without `folderId` the artifact lands at the top level. Returns the new
 * artifact; the hub then tells every client its tasks changed, which refreshes their
 * artifact lists.
 *
 * Reusable: the artifacts screen uploads with it, and so will description attachments
 * (wave 2), which link the returned artifact (`[title](artifact:<id>)`). Platform-free;
 * the app's entry point, sending from the device, is `uploadArtifact` (`upload.ts`).
 */
import type { TaskArtifact } from '@slayzone/task-contracts'
import { authHeaders, type HubTarget, hubApiUrl, readEnvelope, unreachable } from './hub-rest'

export interface UploadFileRequest {
  url: string
  /** `file://` URI of the file to send as the body. */
  fileUri: string
  headers: Record<string, string>
  onProgress?: (sent: number, total: number) => void
  signal?: AbortSignal
}

export interface UploadFileResponse {
  status: number
  body: string
}

/** Sends a file as the raw body of a POST. */
export type UploadFile = (request: UploadFileRequest) => Promise<UploadFileResponse>

export interface UploadArtifactInput {
  taskId: string
  /** The file, and the artifact's title (its name: the extension picks the viewer). */
  file: { uri: string; name: string }
  /** A folder of the task; absent/null = the top level. */
  folderId?: string | null
  onProgress?: (sent: number, total: number) => void
  signal?: AbortSignal
}

/** Uploads with `uploadFile` (the device's: `uploadArtifact` in `upload.ts`). */
export async function uploadArtifactWith(
  uploadFile: UploadFile,
  target: HubTarget,
  input: UploadArtifactInput
): Promise<TaskArtifact> {
  const title = input.file.name.trim()
  if (!title) throw new Error('The file has no name')
  const url = hubApiUrl(target, '/api/artifacts', {
    taskId: input.taskId,
    title,
    folderId: input.folderId ?? undefined
  })
  let response: UploadFileResponse
  try {
    response = await uploadFile({
      url,
      fileUri: input.file.uri,
      // A non-JSON type: the hub reads the body as the file's bytes.
      headers: { ...authHeaders(target), 'content-type': 'application/octet-stream' },
      onProgress: input.onProgress,
      signal: input.signal
    })
  } catch (err) {
    if (input.signal?.aborted) throw err
    throw unreachable(target, err)
  }
  return readEnvelope<TaskArtifact>(target, response.status, response.body)
}
