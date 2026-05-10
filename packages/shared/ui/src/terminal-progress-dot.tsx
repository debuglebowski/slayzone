import * as React from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from './utils'
import { getTerminalStateStyle, ATTENTION_STATE_STYLE } from './terminal-state'
import { ProgressRing } from './progress-ring'
import { Tooltip, TooltipTrigger, TooltipContent } from './tooltip'

export interface TerminalProgressDotProps {
  state: string | undefined
  progress?: number | null
  isDone?: boolean
  /** Render muted fallback dot when no state. Default: false (renders nothing). */
  alwaysShow?: boolean
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left'
  /** Render bare blob without Tooltip wrapper. Default: false. */
  noTooltip?: boolean
  /** Override style with a pulsing amber "needs attention" indicator. */
  needsAttention?: boolean
  size?: number
  className?: string
}

export function TerminalProgressDot({
  state,
  progress,
  isDone,
  alwaysShow = false,
  tooltipSide,
  noTooltip = false,
  needsAttention = false,
  size = 14,
  className,
}: TerminalProgressDotProps): React.JSX.Element | null {
  const baseStyle = getTerminalStateStyle(state)
  const stateStyle = needsAttention ? ATTENTION_STATE_STYLE : baseStyle
  const showProgress = !isDone && progress != null && progress > 0
  const showState = !!stateStyle || alwaysShow
  if (!showState && !showProgress) return null

  const dotColor = stateStyle?.color ?? 'bg-muted-foreground/40'
  const stateLabel = stateStyle?.label ?? 'No session'
  const isRunning = !needsAttention && state === 'running'

  const blob = (
    <span className={cn('relative inline-flex items-center justify-center shrink-0 size-3.5', className)}>
      {showProgress && (
        <ProgressRing value={progress!} size={size} strokeWidth={1.5} className="absolute inset-0" />
      )}
      {showState && (
        isRunning ? (
          <Loader2
            className={cn('relative z-10 size-3 animate-spin', stateStyle?.textColor ?? 'text-green-500')}
            aria-label={stateLabel}
          />
        ) : (
          <span className={cn('relative z-10 size-2 rounded-full', dotColor)} aria-label={stateLabel} />
        )
      )}
    </span>
  )

  if (noTooltip) return blob

  const tooltipText = [
    showState ? stateLabel : null,
    showProgress ? `${Math.round(progress!)}%` : null,
  ].filter(Boolean).join(' - ')

  return (
    <Tooltip>
      <TooltipTrigger asChild>{blob}</TooltipTrigger>
      <TooltipContent side={tooltipSide}>{tooltipText}</TooltipContent>
    </Tooltip>
  )
}
