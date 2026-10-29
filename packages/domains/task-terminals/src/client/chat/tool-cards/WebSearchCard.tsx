import { Search } from 'lucide-react'
import { ToolShell, type ToolProps } from './card-shell'
import { ExternalLink } from './links'
import { webSearchView } from './web-results'

function host(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** WebSearch: the query, its result links (open on click) and any text the search returned. */
export function WebSearchCard({ invocation, timestamp }: ToolProps) {
  const input = invocation.input as {
    query?: string
    allowed_domains?: string[]
    blocked_domains?: string[]
  } | null
  const view = webSearchView(input, invocation.result?.structured, invocation.result?.rawContent)
  const count = view.links.length
  const summary = `"${view.query}"${
    invocation.result && !invocation.result.isError
      ? ` · ${count} result${count === 1 ? '' : 's'}`
      : ''
  }${view.durationSeconds != null ? ` · ${view.durationSeconds.toFixed(1)}s` : ''}`
  const allowed = input?.allowed_domains ?? []
  const blocked = input?.blocked_domains ?? []
  return (
    <ToolShell
      icon={<Search className="size-3" />}
      title="WebSearch"
      invocation={invocation}
      timestamp={timestamp}
      summary={summary}
    >
      <div className="p-3 grid gap-2 text-xs">
        {(allowed.length > 0 || blocked.length > 0) && (
          <div className="text-[11px] text-muted-foreground">
            {allowed.length > 0 && <span>Only {allowed.join(', ')}</span>}
            {allowed.length > 0 && blocked.length > 0 && <span> · </span>}
            {blocked.length > 0 && <span>Excluding {blocked.join(', ')}</span>}
          </div>
        )}
        {count > 0 && (
          <ul className="grid gap-1 max-h-64 overflow-y-auto">
            {view.links.map((l) => (
              <li key={l.url} className="min-w-0">
                <ExternalLink url={l.url} className="max-w-full">
                  <span className="truncate text-foreground">{l.title}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{host(l.url)}</span>
                </ExternalLink>
              </li>
            ))}
          </ul>
        )}
        {view.notes.map((n, i) => (
          <p key={i} className="whitespace-pre-wrap text-muted-foreground">
            {n}
          </p>
        ))}
      </div>
    </ToolShell>
  )
}
