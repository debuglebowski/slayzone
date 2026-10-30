import { useState } from 'react'
import { useArtifactUpload } from '@slayzone/editor/hooks'
import { formatAttachmentSize, type ChatAttachment } from '@slayzone/terminal-contracts'
import { useChatView } from './ChatViewContext'
import {
  AttachmentKindIcon,
  useAttachmentPath,
  useAttachmentPreviewUrl
} from './attachments/AttachmentChip'

/**
 * The files sent with a user message, inside its bubble: images as thumbnails,
 * PDFs and text files by name and size. Clicking one opens it (task artifact).
 */
export function UserMessageAttachments({
  attachments
}: {
  attachments: ChatAttachment[] | undefined
}): React.JSX.Element | null {
  if (!attachments || attachments.length === 0) return null
  return (
    <div className="mb-1.5 flex flex-wrap gap-1.5" data-testid="chat-message-attachments">
      {attachments.map((a, i) => (
        <SentAttachment key={`${a.artifactId}-${i}`} attachment={a} />
      ))}
    </div>
  )
}

function SentAttachment({ attachment }: { attachment: ChatAttachment }): React.JSX.Element {
  const { onOpenFile } = useChatView()
  const { getFilePath } = useArtifactUpload(null)
  const path = useAttachmentPath(attachment)
  const preview = useAttachmentPreviewUrl(attachment)
  const [broken, setBroken] = useState(false)
  const open = (): void => {
    if (!onOpenFile) return
    void (path ? Promise.resolve(path) : getFilePath(attachment.artifactId)).then((p) => {
      if (p) onOpenFile(p)
    })
  }
  if (preview && !broken) {
    return (
      <button
        type="button"
        onClick={open}
        className="overflow-hidden rounded-md border border-border/60 bg-muted/30"
        title={attachment.name}
        aria-label={`Open ${attachment.name}`}
        data-kind="image"
      >
        <img
          src={preview}
          alt={attachment.name}
          className="block max-h-40 max-w-[240px] object-contain"
          onError={() => setBroken(true)}
        />
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={open}
      className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/30 px-2 py-1 text-xs text-foreground/80 hover:bg-muted/60 transition-colors"
      title={attachment.name}
      aria-label={`Open ${attachment.name}`}
      data-kind={attachment.kind}
    >
      <AttachmentKindIcon kind={attachment.kind} className="size-3.5 text-muted-foreground" />
      <span className="max-w-[200px] truncate">{attachment.name}</span>
      <span className="tabular-nums text-muted-foreground/70">
        {formatAttachmentSize(attachment.size)}
      </span>
    </button>
  )
}
