import { useMemo, useState } from 'react'
import { useNow } from '@slayzone/ui'
import { ChevronDown, ChevronRight, Terminal as TerminalIcon } from 'lucide-react'
import type { BgShell, BgShellStatus } from './chat-timeline'

interface BackgroundJobsBannerProps {
  shells: Map<string, BgShell>
  order: string[]
  /** Force-collapse: hide details until user expands. */
  defaultCollapsed?: boolean
  /**
   * When true (default), the banner self-positions at top-right of its parent.
   * Set false when stacking with other banners in a shared column container.
   */
  floating?: boolean
  /** Stop a running job (shown when set, for a job whose id is known). */
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

/** The warning tone at `pct`% opacity, for the banner's glow. */
const glow = (pct: number): string =>
  `color-mix(in oklab, var(--color-warning) ${pct}%, transparent)`

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

function formatAge(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.round(min / 60)
  return `${hr}h`
}

/**
 * Top-right overlay (mirrors LoopModeBanner positioning) listing background
 * shells spawned by the agent in the current chat session. State is owned by
 * the chat-timeline reducer — this component is a pure view.
 */
export function BackgroundJobsBanner({
  shells,
  order,
  defaultCollapsed = false,
  floating = true,
  onStop
}: BackgroundJobsBannerProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)

  const list = useMemo(() => {
    const arr: BgShell[] = []
    for (const id of order) {
      const s = shells.get(id)
      if (s) arr.push(s)
    }
    return arr
  }, [shells, order])

  // Ages tick live, but only while the job rows are on screen.
  const now = useNow(1000, { enabled: list.length > 0 && !collapsed })

  if (list.length === 0) return null

  const activeCount = list.filter((s) => ACTIVE_STATUSES.has(s.status)).length
  const headerActive = activeCount > 0

  return (
    <div
      data-testid="background-jobs-banner"
      className={`${floating ? 'absolute top-6 right-6 z-10 ' : ''}w-72 rounded-xl border-2 ${
        headerActive ? 'border-warning/60' : 'border-border'
      } bg-surface-1 backdrop-blur-md text-xs overflow-hidden transition-all duration-300`}
      style={{
        boxShadow: headerActive
          ? `0 0 20px 0 ${glow(35)}, 0 0 60px 0 ${glow(12)}`
          : `0 4px 20px 0 ${glow(6)}, 0 0 15px 2px ${glow(6)}`
      }}
    >
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className={`w-full flex items-center justify-between px-3 py-2 border-b ${
          headerActive ? 'border-warning/20 bg-warning/5' : 'border-border'
        } hover:bg-muted/30 transition-colors`}
        aria-expanded={!collapsed}
      >
        <span className="flex items-center gap-1.5 font-bold text-foreground tracking-wide">
          <TerminalIcon className="size-3.5" aria-hidden="true" />
          BACKGROUND JOBS
        </span>
        <span className="flex items-center gap-1.5 text-muted-foreground font-mono tabular-nums">
          {activeCount > 0 && <span className="text-foreground">{activeCount}</span>}
          <span>/{list.length}</span>
          {collapsed ? (
            <ChevronRight className="size-3.5" aria-hidden="true" />
          ) : (
            <ChevronDown className="size-3.5" aria-hidden="true" />
          )}
        </span>
      </button>

      {!collapsed && (
        <ul className="divide-y divide-border/40">
          {list.map((shell) => {
            const active = ACTIVE_STATUSES.has(shell.status)
            const age = formatAge(now - shell.spawnedAt)
            return (
              <li key={shell.spawnToolUseId} className="px-3 py-2 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span
                      className={`size-2 rounded-full shrink-0 ${STATUS_DOT_COLORS[shell.status]} ${
                        active ? 'animate-pulse' : ''
                      }`}
                      aria-hidden="true"
                    />
                    <span className="font-mono text-muted-foreground shrink-0">
                      {shell.shellId ?? '…'}
                    </span>
                    <span className="text-foreground truncate">
                      {STATUS_LABELS[shell.status]}
                      {shell.exitCode !== null && shell.status !== 'running' && (
                        <span className="text-muted-foreground"> · code {shell.exitCode}</span>
                      )}
                    </span>
                  </div>
                  <span className="flex items-center gap-1.5 shrink-0">
                    {onStop && active && shell.shellId && (
                      <button
                        type="button"
                        onClick={() => onStop(shell)}
                        aria-label={`Stop background job ${shell.shellId}`}
                        className="rounded px-1.5 py-px text-[10px] text-muted-foreground border border-border hover:bg-muted/60 hover:text-foreground"
                      >
                        Stop
                      </button>
                    )}
                    <span className="text-muted-foreground font-mono tabular-nums">{age}</span>
                  </span>
                </div>
                <div className="font-mono text-muted-foreground leading-snug truncate">
                  $ {truncate(shell.command || shell.description || '', 80)}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
