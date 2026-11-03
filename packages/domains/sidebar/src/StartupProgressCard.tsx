import { Check, Loader2 } from 'lucide-react'
import type { StartupProgress } from './types'

/**
 * Sidebar footer card while a restored workspace comes up: how many agents have
 * started (and how many are booting / waiting for a start slot) and how many tabs
 * have loaded. Shown by the host only during startup.
 *
 * Sized by its container, not by the sidebar view: in the narrow icon rail it folds
 * to the spinner and a percentage, with the full text as its tooltip.
 */
export function StartupProgressCard({ progress }: { progress: StartupProgress }) {
  const { settled, agentsReady, agentsTotal, agentsBooting, agentsQueued, tabsLoaded, tabsTotal } =
    progress
  const total = agentsTotal + tabsTotal
  const percent =
    settled || total === 0 ? 100 : Math.round(((agentsReady + tabsLoaded) / total) * 100)
  const agentDetail = [
    agentsBooting > 0 ? `${agentsBooting} booting` : null,
    agentsQueued > 0 ? `${agentsQueued} queued` : null
  ]
    .filter(Boolean)
    .join(' · ')
  const title = settled ? 'Ready' : 'Starting up'
  const agentsLine =
    agentsTotal > 0
      ? `Agents ${agentsReady}/${agentsTotal}${agentDetail && ` · ${agentDetail}`}`
      : null
  const tabsLine = tabsTotal > 0 ? `Tabs ${tabsLoaded}/${tabsTotal}` : null
  return (
    <div className="@container px-2">
      <div
        role="status"
        aria-label="Startup progress"
        title={[title, agentsLine, tabsLine].filter(Boolean).join('\n')}
        data-testid="startup-progress-card"
        className="relative w-full flex items-start gap-2.5 rounded-md border border-border bg-surface-2 px-3 py-2 overflow-hidden @max-[9rem]:flex-col @max-[9rem]:items-center @max-[9rem]:gap-1 @max-[9rem]:px-1"
      >
        {settled ? (
          <Check className="size-3 mt-0.5 text-primary shrink-0" />
        ) : (
          <Loader2 className="size-3 mt-0.5 text-primary animate-spin shrink-0" />
        )}
        <span className="hidden @max-[9rem]:block text-[10px] text-muted-foreground tabular-nums">
          {percent}%
        </span>
        <span className="flex flex-col gap-0.5 leading-tight flex-1 min-w-0 @max-[9rem]:hidden">
          <span className="text-xs font-medium text-foreground">{title}</span>
          {agentsLine && (
            <span
              data-testid="startup-progress-agents"
              className="text-[10px] text-muted-foreground tabular-nums truncate"
            >
              {agentsLine}
            </span>
          )}
          {tabsLine && (
            <span
              data-testid="startup-progress-tabs"
              className="text-[10px] text-muted-foreground tabular-nums truncate"
            >
              {tabsLine}
            </span>
          )}
        </span>
        <span
          aria-hidden
          className="absolute bottom-0 left-0 h-0.5 bg-primary transition-[width] duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}
