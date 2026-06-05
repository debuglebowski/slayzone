import { ExternalLink } from 'lucide-react'
import { cn } from '@slayzone/ui'
import type { CuratedMcpServer } from '../../../shared/mcp-registry'
import type { CustomMcpServer } from '../types'

export function ServerCard({
  server,
  actions,
  footer,
  className
}: {
  server: CuratedMcpServer
  actions?: React.ReactNode
  footer?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-col justify-between rounded-lg border bg-surface-3 p-4 transition-colors',
        className
      )}
    >
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-medium leading-tight">{server.name}</span>
          <div className="flex shrink-0 items-center gap-1">
            {actions}
            <a
              href={server.url}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded p-0.5 transition-colors hover:bg-muted"
            >
              <ExternalLink className="size-3 text-muted-foreground" />
            </a>
          </div>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{server.description}</p>
      </div>
      {footer && <div className="mt-3 border-t pt-2">{footer}</div>}
    </div>
  )
}

export function CustomServerCard({
  server,
  actions,
  footer,
  className
}: {
  server: CustomMcpServer
  actions?: React.ReactNode
  footer?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-col justify-between rounded-lg border bg-surface-3 p-4 transition-colors',
        className
      )}
    >
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-medium leading-tight">{server.name}</span>
          <div className="flex shrink-0 items-center gap-1">{actions}</div>
        </div>
        {server.description && (
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{server.description}</p>
        )}
        <p
          className={cn(
            'text-xs leading-relaxed text-muted-foreground font-mono',
            server.description ? 'mt-1' : 'mt-2'
          )}
        >
          {server.config.command} {server.config.args.join(' ')}
        </p>
      </div>
      {footer && <div className="mt-3 border-t pt-2">{footer}</div>}
    </div>
  )
}
