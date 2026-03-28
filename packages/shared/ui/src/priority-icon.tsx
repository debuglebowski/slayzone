import { cn } from './utils'

interface PriorityIconProps {
  priority: number
  className?: string
}

export function PriorityIcon({ priority, className }: PriorityIconProps) {
  const size = 'h-4 w-4'

  // Urgent: lightning bolt
  if (priority === 1) {
    return (
      <svg viewBox="0 0 16 16" fill="none" className={cn(size, className)}>
        <path d="M9.5 1.5L4 9h4l-1.5 5.5L13 7H9l.5-5.5z" fill="#f97316" />
      </svg>
    )
  }

  // Someday: three horizontal dashes
  if (priority === 5) {
    return (
      <svg viewBox="0 0 16 16" fill="none" className={cn(size, className)}>
        <path d="M3 5h2M7 5h2M11 5h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-muted-foreground" />
      </svg>
    )
  }

  // High=2 → 3 bars filled, Medium=3 → 2 bars filled, Low=4 → 1 bar filled
  const filled = 5 - priority
  const color = { 2: '#f97316', 3: '#eab308', 4: '#3b82f6' }[priority]
  return (
    <svg viewBox="0 0 16 16" fill="none" className={cn(size, className)}>
      <rect x="2.5" y="10" width="3" height="4" rx="0.5"
        fill={filled >= 1 ? color : undefined}
        className={filled >= 1 ? undefined : 'fill-muted-foreground/25'} />
      <rect x="6.5" y="6.5" width="3" height="7.5" rx="0.5"
        fill={filled >= 2 ? color : undefined}
        className={filled >= 2 ? undefined : 'fill-muted-foreground/25'} />
      <rect x="10.5" y="3" width="3" height="11" rx="0.5"
        fill={filled >= 3 ? color : undefined}
        className={filled >= 3 ? undefined : 'fill-muted-foreground/25'} />
    </svg>
  )
}
