/**
 * A photo attached to a chat message from the phone (camera or library): checked the
 * way desktop checks a file before uploading (what it is by its bytes, `sniffAttachment`;
 * the size limits, `attachmentSizeError`), uploaded as an artifact of the task to the
 * hub that owns it (`uploadArtifact`, the artifact list's own upload), and attached by
 * reference — the hub reads the bytes when the message goes to the agent, as for a file
 * attached on desktop.
 *
 * Photos are delivered as JPEG (`pickUploads`: iOS converts HEIC). Unlike desktop, the
 * phone does not shrink an image first: one over the size limit is refused with why.
 */
import type { TaskArtifact } from '@slayzone/task-contracts'
import {
  type ChatAttachment,
  type ChatAttachmentKind,
  attachmentSizeError,
  sniffAttachment
} from '@slayzone/terminal-contracts'
import { File } from 'expo-file-system'
import type { HubTarget } from '../artifacts/hub-rest'
import type { PickedFile } from '../artifacts/pick-uploads'
import { uploadArtifact } from '../artifacts/upload'

/** Bytes the content sniff reads (`sniffAttachment`). */
const SNIFF_BYTES = 64 * 1024

export interface AttachDeps {
  /** The file's size and its first bytes. */
  read: (uri: string) => { size: number; head: Uint8Array }
  upload: (target: HubTarget, taskId: string, file: PickedFile) => Promise<TaskArtifact>
}

export const deviceAttachDeps: AttachDeps = {
  read: (uri) => {
    const file = new File(uri)
    const handle = file.open()
    try {
      return { size: file.size, head: handle.readBytesSync(Math.min(SNIFF_BYTES, file.size)) }
    } finally {
      handle.close()
    }
  },
  upload: (target, taskId, file) => uploadArtifact(target, { taskId, file })
}

/** Checks, uploads and returns the attachment; throws with why it can't be attached. */
export async function attachFile(
  target: HubTarget,
  taskId: string,
  file: PickedFile,
  kinds: readonly ChatAttachmentKind[],
  deps: AttachDeps = deviceAttachDeps
): Promise<ChatAttachment> {
  const { size, head } = deps.read(file.uri)
  const sniff = sniffAttachment(head, file.name)
  if (sniff.kind === 'unsupported') throw new Error(sniff.reason)
  if (!kinds.includes(sniff.kind)) throw new Error(`${file.name}: this agent can't take that file.`)
  const tooBig = attachmentSizeError(sniff.kind, file.name, size)
  if (tooBig) throw new Error(tooBig)
  const artifact = await deps.upload(target, taskId, file)
  return {
    artifactId: artifact.id,
    name: file.name,
    kind: sniff.kind,
    mediaType: sniff.mediaType,
    size
  }
}
