import { useState } from 'react'
import { FileText, FileType2, Image as ImageIcon, X as XIcon } from 'lucide-react'
import { cn } from '@slayzone/ui'
import { useArtifactUpload } from '@slayzone/editor/hooks'
import { formatAttachmentSize, type ChatAttachment } from '@slayzone/terminal-contracts'
import { useChatView } from '../ChatViewContext'

import { AttachmentHoverPreview } from './AttachmentHoverPreview'
import { useAttachmentPreview } from './useAttachmentPreview'

export function AttachmentKindIcon({
  kind,
  className
}: {
  kind: ChatAttachment['kind']
  className?: string
}): React.JSX.Element {
  if (kind === 'image') return <ImageIcon className={className} />
  if (kind === 'pdf') return <FileType2 className={className} />
  return <FileText className={className} />
}

/** A file attached to the message being written: thumbnail or icon, name, size, remove. */
export function AttachmentChip({
  attachment,
  onRemove
}: {
  attachment: ChatAttachment
  onRemove: () => void
}): React.JSX.Element {
  const { onOpenFile, onOpenArtifact } = useChatView()
  const { getFilePath } = useArtifactUpload(null)
  const { path, src: preview } = useAttachmentPreview(attachment)
  const [broken, setBroken] = useState(false)
  const open = (): void => {
    if (onOpenArtifact) {
      onOpenArtifact(attachment.artifactId)
      return
    }
    if (!onOpenFile) return
    void (path ? Promise.resolve(path) : getFilePath(attachment.artifactId)).then((p) => {
      if (p) onOpenFile(p)
    })
  }
  const openButton = (
    <button
      type="button"
      onClick={open}
      disabled={!onOpenFile && !onOpenArtifact}
      aria-label={`Open ${attachment.name}`}
      className="inline-flex min-w-0 items-center gap-1.5 rounded-sm transition-colors hover:bg-muted/60 disabled:pointer-events-none"
    >
      {preview && !broken ? (
        <img
          src={preview}
          alt=""
          className="size-6 rounded-sm object-cover"
          onError={() => setBroken(true)}
        />
      ) : (
        <span className="flex size-6 items-center justify-center rounded-sm bg-muted">
          <AttachmentKindIcon kind={attachment.kind} className="size-3.5" />
        </span>
      )}
      <span className="max-w-[160px] truncate text-foreground/80">{attachment.name}</span>
      <span className="tabular-nums text-muted-foreground/70">
        {formatAttachmentSize(attachment.size)}
      </span>
    </button>
  )
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 py-0.5 pl-0.5 pr-1 text-[11px] text-muted-foreground"
      title={preview ? undefined : attachment.name}
      data-testid="chat-attachment-chip"
      data-kind={attachment.kind}
    >
      {preview ? (
        <AttachmentHoverPreview name={attachment.name} source={{ url: preview }}>
          {openButton}
        </AttachmentHoverPreview>
      ) : (
        openButton
      )}
      <button
        type="button"
        onClick={onRemove}
        className={cn(
          'rounded p-0.5 transition-colors',
          'hover:bg-destructive/15 hover:text-destructive'
        )}
        aria-label={`Remove ${attachment.name}`}
      >
        <XIcon className="size-2.5" />
      </button>
    </span>
  )
}
