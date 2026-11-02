import { useId, useMemo, useState } from 'react'
import { useNow } from '@slayzone/ui'
import { ChevronRight } from 'lucide-react'
import type { BgShell, BgShellStatus } from '../shared/chat-timeline'

interface BackgroundJobsBannerProps {
  shells: Map<string, BgShell>
  order: string[]
  defaultCollapsed?: boolean
  onStop?: (shell: BgShell) => void
}

const STATUS_LABELS: Record<BgShellStatus, string> = {
  pending: 'Starting',
  running: 'Running',
  completed: 'Completed',
  killed: 'Killed',
  failed: 'Failed',
  unknown: 'Unknown'
}

const STATUS_DOT_COLORS: Record<BgShellStatus, string> = {
  pending: 'bg-info',
  running: 'bg-warning',
  completed: 'bg-success',
  killed: 'bg-muted-foreground',
  failed: 'bg-destructive',
  unknown: 'bg-warning-emphasis'
}

const ACTIVE_STATUSES = new Set<BgShellStatus>(['pending', 'running'])

function formatAge(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m`
  return `${Math.round(min / 60)}h`
}

/** Compact composer disclosure; timeline reducer owns job state. */
export function BackgroundJobsBanner({
  shells,
  order,
  defaultCollapsed = true,
  onStop
}: BackgroundJobsBannerProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const id = useId()
  const active = useMemo(() => {
    const active: BgShell[] = []
    for (const key of order) {
      const shell = shells.get(key)
      if (shell && ACTIVE_STATUSES.has(shell.status)) active.push(shell)
    }
    return active
  }, [shells, order])
  const now = useNow(1000, { enabled: active.length > 0 && !collapsed })
  if (active.length === 0) return null

  const rows = (jobs: BgShell[]) =>
    jobs.map((shell) => {
      const label = shell.description || shell.command || 'Background job'
      return (
        <li key={shell.spawnToolUseId} className="flex min-w-0 items-start gap-2 px-3 py-2">
          <span
            className={`mt-1.5 size-1.5 shrink-0 rounded-full ${STATUS_DOT_COLORS[shell.status]}`}
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-foreground" title={shell.command || label}>
              {label}
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-2 text-muted-foreground">
              <span>{STATUS_LABELS[shell.status]}</span>
              <span className="tabular-nums">{formatAge(now - shell.spawnedAt)}</span>
            </div>
            <details className="mt-1 text-muted-foreground">
              <summary className="w-fit cursor-pointer text-[10px] hover:text-foreground">
                Details
              </summary>
              {shell.shellId && <div className="mt-1 break-all font-mono">{shell.shellId}</div>}
              <div className="mt-1 whitespace-pre-wrap break-all font-mono">
                $ {shell.command || label}
              </div>
            </details>
          </div>
          {onStop && shell.shellId && (
            <button
              type="button"
              onClick={() => onStop(shell)}
              aria-label={`Stop background job ${label}`}
              className="shrink-0 rounded-md border border-border px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Stop
            </button>
          )}
        </li>
      )
    })

  return (
    <div
      data-testid="background-jobs-banner"
      className={`mb-2 ${collapsed ? 'w-fit max-w-full' : 'w-full'} min-w-0 overflow-hidden rounded-md border border-border/50 bg-muted/10 text-xs`}
    >
      <button
        type="button"
        onClick={() => setCollapsed((value) => !value)}
        aria-expanded={!collapsed}
        aria-controls={id}
        className="flex w-full items-center gap-1.5 px-2 py-[5px] text-[10px] leading-4 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
      >
        <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-hidden="true" />
        <span className="min-w-0 truncate">
          {active.length} {active.length === 1 ? 'job' : 'jobs'} running
        </span>
        <ChevronRight
          className={`ml-auto size-3 shrink-0 transition-transform ${collapsed ? '' : 'rotate-90'}`}
          aria-hidden="true"
        />
      </button>
      {!collapsed && (
        <div id={id} className="max-h-56 overflow-y-auto border-t border-border/40 bg-muted/20">
          <ul className="divide-y divide-border/40">{rows(active)}</ul>
        </div>
      )}
    </div>
  )
}
