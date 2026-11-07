import { Bot, ChevronRight, Loader2 } from 'lucide-react'
import { cn } from '@slayzone/ui'

/**
 * The Sub-agents disclosure button: a turn's (beside its Activities) and the
 * composer's (sub-agents still running after their turn) — one look for both.
 * A spinner while any runs.
 */
export function SubAgentsPill({
  running,
  count,
  expanded,
  onToggle,
  controls,
  testId
}: {
  /** Any of them still runs: the spinner. */
  running: boolean
  /** What follows the label ("2 of 3 running", "3"). */
  count: string
  expanded: boolean
  onToggle: () => void
  /** Id of the panel it opens. */
  controls: string
  testId: string
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onToggle}
      data-testid={testId}
      className="flex w-fit max-w-full items-center gap-2 rounded-lg border border-border/50 bg-card/40 px-3 py-1.5 text-left text-xs text-muted-foreground shadow-sm hover:bg-muted/50"
    >
      {running ? (
        <Loader2 className="size-3 shrink-0 animate-spin text-agent" />
      ) : (
        <Bot className="size-3 shrink-0" />
      )}
      <span className="font-medium text-foreground">Sub-agents</span>
      <span>{count}</span>
      <ChevronRight
        className={cn(
          'size-3 transition-transform motion-reduce:transition-none',
          expanded && 'rotate-90'
        )}
      />
    </button>
  )
}
