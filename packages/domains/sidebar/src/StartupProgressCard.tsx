import { Check, Loader2 } from 'lucide-react'
import { describeStartupProgress } from './startup-progress-text'
import type { StartupProgress } from './types'

/**
 * Sidebar footer card while a restored workspace comes up: "Starting up", and what
 * is still left per stage (task pages, agents, hidden terminals, chats) — finished
 * stages drop out. The full per-stage counts are its tooltip. Shown by the host only
 * during startup.
 *
 * Sized by its container, not by the sidebar view: in the narrow icon rail it folds
 * to the spinner and a percentage, with the full text as its tooltip.
 */
export function StartupProgressCard({ progress }: { progress: StartupProgress }) {
  const { title, left, percent, details } = describeStartupProgress(progress)
  return (
    <div className="@container px-2">
      <div
        role="status"
        aria-label="Startup progress"
        title={[title, left, ...details].join('\n')}
        data-testid="startup-progress-card"
        className="relative w-full flex items-start gap-2.5 rounded-md border border-border bg-surface-2 px-3 py-2 overflow-hidden @max-[9rem]:flex-col @max-[9rem]:items-center @max-[9rem]:gap-1 @max-[9rem]:px-1"
      >
        {progress.settled ? (
          <Check className="size-3 mt-0.5 text-primary shrink-0" />
        ) : (
          <Loader2 className="size-3 mt-0.5 text-primary animate-spin shrink-0" />
        )}
        <span className="hidden @max-[9rem]:block text-[10px] text-muted-foreground tabular-nums">
          {percent}%
        </span>
        <span className="flex flex-col gap-0.5 leading-tight flex-1 min-w-0 @max-[9rem]:hidden">
          <span className="text-xs font-medium text-foreground">{title}</span>
          <span
            data-testid="startup-progress-left"
            className="text-[10px] text-muted-foreground tabular-nums text-pretty"
          >
            {left}
          </span>
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
