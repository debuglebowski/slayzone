/**
 * `uploadArtifact`: upload a file from the phone as a new artifact of a task, on the hub
 * that owns it (see `upload-request.ts`), the OS streaming the file from disk
 * (`File.upload`, never read into JS).
 */
import type { TaskArtifact } from '@slayzone/task-contracts'
import { File, UploadType } from 'expo-file-system'
import type { HubTarget } from './hub-rest'
import { type UploadArtifactInput, type UploadFile, uploadArtifactWith } from './upload-request'

export * from './upload-request'

/** `UploadFile` on the device: the OS streams the file (`expo-file-system`). */
export const uploadFileFromDevice: UploadFile = async (request) => {
  const result = await new File(request.fileUri).upload(request.url, {
    httpMethod: 'POST',
    uploadType: UploadType.BINARY_CONTENT,
    headers: request.headers,
    signal: request.signal,
    onProgress: request.onProgress
      ? ({ bytesSent, totalBytes }) => request.onProgress?.(bytesSent, totalBytes)
      : undefined
  })
  return { status: result.status, body: result.body }
}

export function uploadArtifact(
  target: HubTarget,
  input: UploadArtifactInput,
  deps: { uploadFile: UploadFile } = { uploadFile: uploadFileFromDevice }
): Promise<TaskArtifact> {
  return uploadArtifactWith(deps.uploadFile, target, input)
}
