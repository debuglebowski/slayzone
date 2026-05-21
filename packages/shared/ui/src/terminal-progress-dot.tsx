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
  /** Larger footprint while running / loading. Default: same as `size`. */
  activeSize?: number
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
  activeSize = size,
  className
}: TerminalProgressDotProps): React.JSX.Element | null {
  const baseStyle = getTerminalStateStyle(state)
  const stateStyle = needsAttention ? ATTENTION_STATE_STYLE : baseStyle
  const showProgress = !isDone && progress != null && progress > 0
  const showState = !!stateStyle || alwaysShow
  if (!showState && !showProgress) return null

  const dotColor = stateStyle?.color ?? 'bg-muted-foreground/40'
  const stateLabel = stateStyle?.label ?? 'No session'
  const isRunning = !needsAttention && state === 'running'

  // Wrapper footprint is the constant max of size/activeSize, so the row layout
  // never shifts when a terminal goes active. The indicator renders at `size`
  // normally and `activeSize` only while running — a mere progress value does
  // not enlarge it. Always <= footprint, so it sits inside the wrapper (no
  // flex-shrink, no clipping). Blob and ring stay even-sized; with an even
  // footprint the free space splits to whole pixels — pixel-perfect concentric.
  const renderSize = isRunning ? activeSize : size
  const footprint = Math.max(size, activeSize)
  const innerSize = Math.round((renderSize * 0.85) / 2) * 2
  // Progress ring is sized off `size`, not `renderSize`, so its radius stays
  // fixed regardless of terminal state.
  const ringSize = size + 6
  const ringInset = (footprint - ringSize) / 2

  const blob = (
    <span
      className={cn('relative inline-flex items-center justify-center shrink-0', className)}
      style={{ width: footprint, height: footprint }}
    >
      {showProgress && (
        <ProgressRing
          value={progress!}
          size={ringSize}
          strokeWidth={1.5}
          className="absolute"
          style={{ left: ringInset, top: ringInset }}
        />
      )}
      {showState &&
        (isRunning ? (
          <Loader2
            size={innerSize}
            strokeWidth={2.75}
            className={cn(
              'relative z-10 shrink-0 animate-spin',
              stateStyle?.textColor ?? 'text-green-500'
            )}
            aria-label={stateLabel}
          />
        ) : (
          <span
            className={cn('relative z-10 shrink-0 rounded-full', dotColor)}
            style={{ width: innerSize, height: innerSize }}
            aria-label={stateLabel}
          />
        ))}
    </span>
  )

  if (noTooltip) return blob

  const tooltipText = [
    showState ? stateLabel : null,
    showProgress ? `${Math.round(progress!)}%` : null
  ]
    .filter(Boolean)
    .join(' - ')

  return (
    <Tooltip>
      <TooltipTrigger asChild>{blob}</TooltipTrigger>
      <TooltipContent side={tooltipSide}>{tooltipText}</TooltipContent>
    </Tooltip>
  )
}
