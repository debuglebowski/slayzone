import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { FileText, FileType2, Image as ImageIcon, X as XIcon } from 'lucide-react'
import { cn } from '@slayzone/ui'
import { useArtifactUpload } from '@slayzone/editor/hooks'
import { toSlzFileUrl } from '@slayzone/platform/slz-file-url'
import { formatAttachmentSize, type ChatAttachment } from '@slayzone/terminal-contracts'

/** The attachment's file on disk (an artifact of the task), resolved once and cached. */
export function useAttachmentPath(attachment: ChatAttachment): string | null {
  const { getFilePath } = useArtifactUpload(null)
  const { data } = useQuery({
    queryKey: ['chat-attachment-path', attachment.artifactId],
    queryFn: () => getFilePath(attachment.artifactId),
    staleTime: Infinity
  })
  return data ?? null
}

/**
 * An image's thumbnail URL (the desktop app's `slz-file:` protocol), or null —
 * for non-images, while resolving, and where files can't be shown (web shell).
 */
export function useAttachmentPreviewUrl(attachment: ChatAttachment): string | null {
  const path = useAttachmentPath(attachment)
  if (attachment.kind !== 'image' || !path) return null
  return toSlzFileUrl(path, attachment.contentHash)
}

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
  const preview = useAttachmentPreviewUrl(attachment)
  const [broken, setBroken] = useState(false)
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 py-0.5 pl-0.5 pr-1 text-[11px] text-muted-foreground"
      title={attachment.name}
      data-testid="chat-attachment-chip"
      data-kind={attachment.kind}
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
