import { Globe } from 'lucide-react'
import { GhMarkdown } from '@slayzone/markdown/client'
import { LinkText, ToolShell, resultTextOf, type ToolProps } from './card-shell'
import { ExternalLink } from './links'
import { webFetchView } from './web-results'

/** `host/path?query` of a URL, for a one-line summary. */
export function shortUrl(url: string): string {
  try {
    const u = new URL(url)
    const rest = `${u.pathname === '/' ? '' : u.pathname}${u.search}`
    return `${u.host.replace(/^www\./, '')}${rest}`
  } catch {
    return url
  }
}

/** WebFetch: the URL, what was asked, the HTTP status and the answer or page text. */
export function WebFetchCard({ invocation, timestamp }: ToolProps) {
  const view = webFetchView(
    invocation.input,
    invocation.result?.structured,
    invocation.result?.rawContent
  )
  const error = invocation.result?.isError ? resultTextOf(invocation) : ''
  return (
    <ToolShell
      icon={<Globe className="size-3" />}
      title="WebFetch"
      invocation={invocation}
      timestamp={timestamp}
      summary={shortUrl(view.url)}
    >
      <div className="p-3 grid gap-2 text-xs">
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          {view.url && (
            <ExternalLink
              url={view.url}
              testId="tool-url-link"
              className="font-mono text-[11px] text-primary"
            >
              <span className="truncate">{view.url}</span>
            </ExternalLink>
          )}
          {view.status && (
            <span className="rounded-sm border border-border/60 px-1 font-mono text-[10px]">
              {view.status}
            </span>
          )}
          {view.details?.map((d) => (
            <span key={d} className="text-[11px] text-muted-foreground">
              {d}
            </span>
          ))}
        </div>
        {view.prompt && (
          <div className="flex gap-1.5">
            <span className="shrink-0 text-muted-foreground">Asked:</span>
            <span className="whitespace-pre-wrap">{view.prompt}</span>
          </div>
        )}
        {error && <pre className="font-mono whitespace-pre-wrap text-destructive">{error}</pre>}
        {view.summary && (
          <div className="text-sm leading-relaxed [&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_code]:font-mono [&_code]:text-[0.85em]">
            <GhMarkdown>{view.summary}</GhMarkdown>
          </div>
        )}
        {view.content && (
          <pre className="max-h-64 overflow-y-auto rounded bg-muted/30 p-2 font-mono whitespace-pre-wrap text-muted-foreground">
            <LinkText text={view.content} />
          </pre>
        )}
      </div>
    </ToolShell>
  )
}
