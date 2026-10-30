import { useRef, useState } from 'react'
import { safeRandomUUID, toast, useStableCallback } from '@slayzone/ui'
import {
  extractFilesFromDataTransfer,
  extractImageFilesFromDataTransfer,
  useArtifactUpload
} from '@slayzone/editor/hooks'
import {
  CHAT_IMAGE_MEDIA_TYPES,
  chatCapabilitiesForMode,
  type ChatAttachment,
  type ChatImageMediaType
} from '@slayzone/terminal-contracts'
import { browserImageCodec, prepareAttachmentFile, type ImageCodec } from './prepare-attachment'

export interface PendingAttachment {
  key: string
  name: string
}

export interface UseChatAttachmentsOpts {
  taskId: string
  mode: string
  /** Files ready to send (uploaded task artifacts), in the order they were given. */
  onAdded: (attachments: ChatAttachment[]) => void
  /** Image decode/encode; the browser's by default (tests inject one). */
  codec?: ImageCodec
}

export interface UseChatAttachmentsResult {
  /** Files being checked / uploaded right now. */
  pending: PendingAttachment[]
  isDragging: boolean
  addFiles: (files: File[]) => Promise<void>
  onDragEnter: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: () => void
  onDrop: (e: React.DragEvent) => void
  onPaste: (e: React.ClipboardEvent) => void
}

function imageMediaType(type: string): ChatImageMediaType {
  return (CHAT_IMAGE_MEDIA_TYPES as readonly string[]).includes(type)
    ? (type as ChatImageMediaType)
    : 'image/png'
}

/**
 * Attaching files to a chat message: file picker, paste and drop. Each file is
 * uploaded to the task's "Uploads" folder and added as a reference.
 *
 * `attachments: 'blocks'` (Claude): any file is checked by content first
 * (`prepareAttachmentFile`: images converted/shrunk, PDFs and text checked
 * against the limits) and a file that can't be sent is refused with its reason.
 * `'paths'` (Codex): images only, unchecked — exactly as before.
 */
export function useChatAttachments({
  taskId,
  mode,
  onAdded,
  codec = browserImageCodec
}: UseChatAttachmentsOpts): UseChatAttachmentsResult {
  const policy = chatCapabilitiesForMode(mode).attachments
  const { uploadFiles } = useArtifactUpload(taskId, { folderName: 'Uploads' })
  const [pending, setPending] = useState<PendingAttachment[]>([])
  const [isDragging, setIsDragging] = useState(false)
  // Nested dragenter/leave pairs (children of the panel): written in handlers only.
  const dragDepth = useRef(0)

  const attachOne = async (file: File): Promise<ChatAttachment | null> => {
    if (policy === 'paths') {
      const [ref] = await uploadFiles([file])
      if (!ref) return null
      return {
        artifactId: ref.id,
        name: ref.title,
        kind: 'image',
        mediaType: imageMediaType(file.type),
        size: file.size
      }
    }
    const prepared = await prepareAttachmentFile(file, codec)
    if (!prepared.ok) {
      toast(prepared.reason)
      return null
    }
    const [ref] = await uploadFiles([prepared.file])
    if (!ref) return null
    return {
      artifactId: ref.id,
      name: ref.title,
      kind: prepared.kind,
      mediaType: prepared.mediaType,
      size: prepared.file.size
    }
  }

  const addFiles = useStableCallback(async (files: File[]): Promise<void> => {
    const taken = policy === 'paths' ? files.filter((f) => f.type.startsWith('image/')) : files
    if (taken.length === 0) return
    const batch = taken.map((file) => ({
      key: safeRandomUUID(),
      name: file.name || 'pasted image',
      file
    }))
    setPending((prev) => [...prev, ...batch.map(({ key, name }) => ({ key, name }))])
    const results = await Promise.all(
      batch.map(({ key, name, file }) =>
        attachOne(file)
          .catch((err: unknown) => {
            const why = err instanceof Error ? err.message : String(err)
            toast(
              policy === 'paths'
                ? `Image upload failed: ${why}`
                : `Attaching ${name} failed: ${why}`
            )
            return null
          })
          .then((attachment) => {
            setPending((prev) => prev.filter((p) => p.key !== key))
            return attachment
          })
      )
    )
    const added = results.filter((a): a is ChatAttachment => a !== null)
    if (added.length > 0) onAdded(added)
  })

  const extract = (dt: DataTransfer | null | undefined): File[] =>
    policy === 'paths' ? extractImageFilesFromDataTransfer(dt) : extractFilesFromDataTransfer(dt)

  const onDragEnter = useStableCallback((e: React.DragEvent) => {
    if (!e.dataTransfer?.types.includes('Files')) return
    e.preventDefault()
    dragDepth.current += 1
    if (dragDepth.current === 1) setIsDragging(true)
  })
  const onDragOver = useStableCallback((e: React.DragEvent) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
  })
  const onDragLeave = useStableCallback(() => {
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setIsDragging(false)
  })
  const onDrop = useStableCallback((e: React.DragEvent) => {
    const files = extract(e.dataTransfer)
    dragDepth.current = 0
    setIsDragging(false)
    if (files.length === 0) return
    e.preventDefault()
    void addFiles(files)
  })
  const onPaste = useStableCallback((e: React.ClipboardEvent) => {
    const clip = e.clipboardData
    // A copy from Office / Sheets carries its text AND a picture of it: the text wins.
    if (
      policy === 'blocks' &&
      clip.types.includes('text/html') &&
      clip.getData('text/plain').trim() !== ''
    ) {
      return
    }
    const files = extract(clip)
    if (files.length === 0) return
    e.preventDefault()
    void addFiles(files)
  })

  return { pending, isDragging, addFiles, onDragEnter, onDragOver, onDragLeave, onDrop, onPaste }
}
