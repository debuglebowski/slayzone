import { useState, type ReactElement } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@slayzone/ui'
import type { ChatAttachment } from '@slayzone/terminal-contracts'
import { useAttachmentPreview } from './useAttachmentPreview'

type PreviewSource = { attachment: ChatAttachment } | { url: string | null }

/** A portal keeps the image outside the message card and virtualized row. */
export function AttachmentHoverPreview({
  name,
  source,
  children
}: {
  name: string
  source: PreviewSource
  children: ReactElement
}): React.JSX.Element {
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        side="top"
        align="end"
        sideOffset={6}
        showArrow={false}
        className="max-w-[min(400px,80vw)] overflow-hidden rounded-lg border border-agent-foreground/65 bg-popover p-0 text-popover-foreground shadow-[0_18px_40px_rgb(0_0_0/0.18),0_5px_12px_rgb(0_0_0/0.10)] ring-2 ring-agent/15 dark:shadow-[0_18px_40px_rgb(0_0_0/0.53),0_5px_12px_rgb(0_0_0/0.33)]"
      >
        {'attachment' in source ? (
          <ArtifactPreview attachment={source.attachment} />
        ) : (
          <PreviewImage key={source.url} name={name} src={source.url} />
        )}
      </TooltipContent>
    </Tooltip>
  )
}

function ArtifactPreview({ attachment }: { attachment: ChatAttachment }): React.JSX.Element {
  const { src, loading } = useAttachmentPreview(attachment)
  if (loading) return <span>Loading preview…</span>
  return <PreviewImage key={src} name={attachment.name} src={src} />
}

function PreviewImage({ name, src }: { name: string; src: string | null }): React.JSX.Element {
  const [broken, setBroken] = useState(false)
  if (!src || broken) return <span>Preview unavailable</span>
  return (
    <img
      src={src}
      alt={name}
      className="block max-h-80 max-w-full rounded object-contain"
      onError={() => setBroken(true)}
    />
  )
}
