/**
 * The composer's ＋: a photo from the camera or the library, uploaded to the task's hub
 * and attached to the next message (`attach-files.ts`). Offered when the chat knows its
 * hub (`ChatUploadTarget`) and the agent takes images. A failure is said (`notify`), the
 * draft is untouched.
 */
import type { ChatAttachment, ChatCapabilities } from '@slayzone/terminal-contracts'
import { useState } from 'react'
import { pickUploads } from '../artifacts/pick-uploads'
import { attachFile } from './attach-files'
import { useChatUploadTarget } from './ChatUploadTarget'

export type AttachSource = 'camera' | 'photos'

export interface ChatAttach {
  /** Uploads on their way. */
  uploading: number
  pick: (source: AttachSource) => void
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Null when this chat can't attach (no hub to upload to, or no images for this agent). */
export function useChatAttach({
  taskId,
  caps,
  onAttached,
  notify
}: {
  taskId: string
  caps: ChatCapabilities
  onAttached: (files: readonly ChatAttachment[]) => void
  notify: (message: string) => void
}): ChatAttach | null {
  const target = useChatUploadTarget()
  const [uploading, setUploading] = useState(0)
  if (!target || !caps.attachmentKinds.includes('image')) return null
  const pick = (source: AttachSource) => {
    pickUploads(source)
      .then((files) => {
        setUploading((n) => n + files.length)
        for (const file of files) {
          attachFile(target, taskId, file, caps.attachmentKinds)
            .then(
              (attachment) => onAttached([attachment]),
              (err: unknown) => notify(`Couldn't attach ${file.name}: ${messageOf(err)}`)
            )
            .then(() => setUploading((n) => n - 1))
        }
      })
      .catch((err: unknown) => notify(messageOf(err)))
  }
  return { uploading, pick }
}
