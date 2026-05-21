import * as React from 'react'

import { cn } from './utils'

interface ProgressRingProps {
  value: number
  size: number
  strokeWidth?: number
  className?: string
  style?: React.CSSProperties
  trackClassName?: string
  rangeClassName?: string
  'aria-label'?: string
}

function ProgressRing({
  value,
  size,
  strokeWidth = 2,
  className,
  style,
  trackClassName = 'stroke-muted',
  rangeClassName = 'stroke-primary',
  'aria-label': ariaLabel
}: ProgressRingProps): React.JSX.Element {
  const clamped = Math.max(0, Math.min(100, value))
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - clamped / 100)

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={cn('shrink-0', className)}
      style={style}
      role="img"
      aria-label={ariaLabel ?? `${Math.round(clamped)}% complete`}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth={strokeWidth}
        className={trackClassName}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth={strokeWidth}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        className={cn(rangeClassName, 'transition-[stroke-dashoffset] duration-150')}
      />
    </svg>
  )
}

export { ProgressRing, type ProgressRingProps }
