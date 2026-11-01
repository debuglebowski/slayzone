import type { ReactNode } from 'react'
import { useArtifactUpload } from '@slayzone/editor/hooks'
import { formatAttachmentSize, type ChatAttachment } from '@slayzone/terminal-contracts'
import { useChatView } from './ChatViewContext'
import { HighlightedText } from './HighlightedText'
import { AttachmentKindIcon } from './attachments/AttachmentChip'

/** Codex path-based uploads are saved as leading image Markdown in the prompt. */
export function UserMessageContent({
  text,
  attachments,
  children
}: {
  text: string
  attachments?: ChatAttachment[]
  children?: ReactNode
}): React.JSX.Element {
  const images: { name: string; path: string }[] = []
  let remaining = text
  while (true) {
    // Match only the generated prefix; keep ordinary text and code verbatim.
    // Greedy path matching preserves spaces and parentheses in filenames.
    const match = /^!\[([^\r\n]*)\]\((\/[^\r\n]+|[A-Za-z]:[\\/][^\r\n]+)\)[ \t]*(?:\r?\n|$)/.exec(
      remaining
    )
    if (!match) break
    images.push({ name: match[1], path: match[2] })
    remaining = remaining.slice(match[0].length)
  }
  const messageText = images.length > 0 ? remaining.replace(/^\r?\n/, '') : text
  return (
    <div className="max-w-[85%] min-w-0 flex flex-col items-end gap-1.5">
      {(messageText || children) && (
        <div
          data-testid="chat-user-message-card"
          className="max-w-full min-w-0 rounded-lg border border-primary/25 bg-primary/5 shadow-sm px-3 py-2 text-sm text-foreground whitespace-pre-wrap break-words"
        >
          <HighlightedText text={messageText} />
          {children}
        </div>
      )}
      <UserMessageAttachments attachments={attachments} />
      {images.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {images.map((image, i) => (
            <PathImageAttachment key={`${image.path}-${i}`} {...image} />
          ))}
        </div>
      )}
    </div>
  )
}

function PathImageAttachment({ name, path }: { name: string; path: string }): React.JSX.Element {
  const { onOpenFile, onOpenArtifact } = useChatView()
  return (
    <button
      type="button"
      onClick={() => {
        const artifactId = /\/artifacts\/[^/]+\/([a-f0-9-]{36})(?:\.[^/]*)?$/i.exec(
          path.replaceAll('\\', '/')
        )?.[1]
        if (artifactId && onOpenArtifact) onOpenArtifact(artifactId)
        else onOpenFile?.(path)
      }}
      disabled={!onOpenFile && !onOpenArtifact}
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/60 bg-muted/30 px-2 py-1 text-xs text-foreground/80 hover:bg-muted/60 transition-colors"
      title={name}
      aria-label={`Open ${name}`}
    >
      <AttachmentKindIcon kind="image" className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="max-w-[200px] truncate">{name}</span>
    </button>
  )
}

/**
 * Compact files below a user message. Clicking one opens its task artifact.
 */
export function UserMessageAttachments({
  attachments
}: {
  attachments: ChatAttachment[] | undefined
}): React.JSX.Element | null {
  if (!attachments || attachments.length === 0) return null
  return (
    <div className="flex flex-wrap justify-end gap-1.5" data-testid="chat-message-attachments">
      {attachments.map((a, i) => (
        <SentAttachment key={`${a.artifactId}-${i}`} attachment={a} />
      ))}
    </div>
  )
}

function SentAttachment({ attachment }: { attachment: ChatAttachment }): React.JSX.Element {
  const { onOpenFile, onOpenArtifact } = useChatView()
  const { getFilePath } = useArtifactUpload(null)
  const open = (): void => {
    if (onOpenArtifact) {
      onOpenArtifact(attachment.artifactId)
      return
    }
    if (!onOpenFile) return
    void getFilePath(attachment.artifactId).then((p) => {
      if (p) onOpenFile(p)
    })
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
