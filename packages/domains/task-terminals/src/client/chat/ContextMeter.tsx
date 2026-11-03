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
          {share !== null && <ContextRing share={share} />}
          {shown}
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        sideOffset={6}
        showArrow={false}
        className="w-60 overflow-hidden rounded-lg border border-border bg-popover p-0 text-popover-foreground shadow-lg"
      >
        <ContextMeterCard summary={summary} />
      </TooltipContent>
    </Tooltip>
  )
}

type Level = 'ok' | 'warn' | 'full'

/** At or above this share the meter turns amber. */
const FILLING = 0.6

function levelOf(share: number): Level {
  return share >= NEARLY_FULL ? 'full' : share >= FILLING ? 'warn' : 'ok'
}

const LEVEL_TEXT: Record<Level, string> = {
  ok: 'text-success-foreground',
  warn: 'text-warning-foreground',
  full: 'text-destructive'
}
const LEVEL_BG: Record<Level, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  full: 'bg-destructive'
}
const LEVEL_STROKE: Record<Level, string> = {
  ok: 'stroke-success',
  warn: 'stroke-warning',
  full: 'stroke-destructive'
}

/** Tooltip body: share used + tokens, fill bar, session cost. */
export function ContextMeterCard({ summary }: { summary: UsageSummary }) {
  const { contextTokens, contextWindow, sessionCostUsd } = summary
  const share =
    contextTokens !== null && contextWindow !== null && contextWindow > 0
      ? contextTokens / contextWindow
      : null
  const level = share !== null ? levelOf(share) : null
  return (
    <div data-testid="chat-context-meter-card" className="flex flex-col gap-2.5 p-3 text-xs">
      {contextTokens !== null && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-4 tabular-nums">
            <span>
              {share !== null && level !== null && (
                <span className={cn('font-semibold', LEVEL_TEXT[level])}>
                  {Math.round(share * 100)}%{' '}
                </span>
              )}
              <span className="text-muted-foreground">context used</span>
            </span>
            <span className="text-muted-foreground">
              {formatTokens(contextTokens)}
              {contextWindow !== null ? ` / ${formatTokens(contextWindow)}` : ' tokens'}
            </span>
          </div>
          {share !== null && level !== null && (
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                data-testid="chat-context-meter-bar"
                className={cn('h-full rounded-full transition-[width]', LEVEL_BG[level])}
                style={{ width: `${Math.min(1, Math.max(0, share)) * 100}%` }}
              />
            </div>
          )}
          {level === 'full' && (
            <span className="text-destructive">Almost full, compacting soon</span>
          )}
        </div>
      )}
      {sessionCostUsd !== null && (
        <div
          className={cn(
            'flex items-baseline justify-between gap-4',
            contextTokens !== null && 'border-t border-border pt-2.5'
          )}
        >
          <span className="text-muted-foreground">Session cost</span>
          <span className="font-semibold tabular-nums text-info-foreground">
            {formatCost(sessionCostUsd)}
          </span>
        </div>
      )}
    </div>
  )
}

function ContextRing({ share }: { share: number }) {
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
        className={LEVEL_STROKE[levelOf(share)]}
      />
    </svg>
  )
}
