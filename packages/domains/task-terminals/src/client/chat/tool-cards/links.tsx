import { FileText, Globe } from 'lucide-react'
import { cn } from '@slayzone/ui'
import { useChatView } from '../ChatViewContext'
import { useTRPCClient } from '../../trpc'

/** File path a card names — click opens it in the editor (falls back to the OS). */
export function FileLink({
  path,
  label
}: {
  path: string /** Shown instead of the path. */
  label?: string
}) {
  const { onOpenFile } = useChatView()
  const trpcClient = useTRPCClient()
  const open = (): void => {
    if (onOpenFile) onOpenFile(path)
    else void trpcClient.app.shell.openPath.mutate({ absPath: path })
  }
  return (
    <button
      type="button"
      data-testid="tool-file-link"
      onClick={open}
      title={`Open ${path}`}
      className="inline-flex min-w-0 items-center gap-1 font-mono text-[11px] text-primary hover:underline"
    >
      <FileText className="size-3 shrink-0" />
      {/* Truncate from the start so the file name stays visible. */}
      <span className="truncate [direction:rtl]">
        <bdi>{label ?? path}</bdi>
      </span>
    </button>
  )
}

/**
 * URL a card links to — click opens it in the task browser (falls back to the
 * system browser); Shift+click always opens the system browser.
 */
export function ExternalLink({
  url,
  children,
  testId,
  className
}: {
  url: string
  children: React.ReactNode
  testId?: string
  className?: string
}) {
  const { onOpenUrl } = useChatView()
  const trpcClient = useTRPCClient()
  const open = (e: React.MouseEvent): void => {
    if (onOpenUrl && !e.shiftKey) onOpenUrl(url)
    else void trpcClient.app.shell.openExternal.mutate({ url })
  }
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={open}
      title={url}
      className={cn(
        'inline-flex min-w-0 items-center gap-1.5 text-left hover:underline',
        className
      )}
    >
      <Globe className="size-3 shrink-0 text-muted-foreground" />
      {children}
    </button>
  )
}

/** Small label next to a card's file link (e.g. "New file"). */
export function CardBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 rounded-sm border border-border/60 px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
      {children}
    </span>
  )
}
