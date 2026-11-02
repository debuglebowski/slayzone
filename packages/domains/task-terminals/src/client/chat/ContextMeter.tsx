import { cn, Tooltip, TooltipContent, TooltipTrigger } from '@slayzone/ui'
import type { UsageSummary } from '@slayzone/terminal/client'
import { formatCost, formatTokens } from './usage-format'

/** At or above this share of the context window the meter is flagged. */
const NEARLY_FULL = 0.9

/**
 * Composer footer readout: how full the context window is. Shows the share only;
 * tokens and session cost live in its tooltip. Falls back to what the provider
 * reported (no window → tokens; no context → cost); nothing at all when it
 * reported nothing.
 */
export function ContextMeter({ summary }: { summary: UsageSummary | null }) {
  if (!summary) return null
  const { contextTokens, contextWindow, sessionCostUsd } = summary
  const share =
    contextTokens !== null && contextWindow !== null && contextWindow > 0
      ? contextTokens / contextWindow
      : null
  const details: string[] = []
  let shown: string | null = null
  if (contextTokens !== null) {
    if (share !== null && contextWindow !== null) {
      const pct = Math.round(share * 100)
      shown = `${pct}%`
      details.push(
        `Context: ${contextTokens.toLocaleString('en-US')} of ${contextWindow.toLocaleString('en-US')} tokens (${pct}%)`
      )
    } else {
      shown = `${formatTokens(contextTokens)} tokens`
      details.push(`Context: ${contextTokens.toLocaleString('en-US')} tokens`)
    }
  }
  if (sessionCostUsd !== null) {
    if (shown === null) shown = formatCost(sessionCostUsd)
    details.push(`Session cost: $${sessionCostUsd.toFixed(4)}`)
  }
  if (shown === null) return null
  const nearlyFull = share !== null && share >= NEARLY_FULL
  const label = details.join('\n')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid="chat-context-meter"
          role="status"
          aria-label={label}
          className={cn('flex items-center gap-1.5 tabular-nums', nearlyFull && 'text-destructive')}
        >
          {share !== null && <ContextRing share={share} nearlyFull={nearlyFull} />}
          {shown}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="whitespace-pre-line">
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

function ContextRing({ share, nearlyFull }: { share: number; nearlyFull: boolean }) {
  const r = 5
  const circumference = 2 * Math.PI * r
  const filled = Math.min(1, Math.max(0, share)) * circumference
  return (
    <svg viewBox="0 0 14 14" className="size-3 -rotate-90" aria-hidden>
      <circle cx="7" cy="7" r={r} fill="none" strokeWidth="2" className="stroke-border" />
      <circle
        cx="7"
        cy="7"
        r={r}
        fill="none"
        strokeWidth="2"
        strokeDasharray={`${filled} ${circumference}`}
        className={nearlyFull ? 'stroke-destructive' : 'stroke-primary'}
      />
    </svg>
  )
}
