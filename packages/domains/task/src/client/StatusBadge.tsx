import { cn } from '@slayzone/ui'
import type { ProcessStatus } from './ProcessesPanel.types'

const STATUS_CONFIG: Record<ProcessStatus, { label: string; dot: string; badge: string }> = {
  running: {
    label: 'Running',
    dot: 'bg-green-500',
    badge: 'text-green-500 bg-green-500/10 border-green-500/20'
  },
  stopped: {
    label: 'Idle',
    dot: 'bg-muted-foreground/30',
    badge: 'text-muted-foreground bg-muted/60 border-border'
  },
  completed: {
    label: 'Completed',
    dot: 'bg-blue-400',
    badge: 'text-blue-400 bg-blue-400/10 border-blue-400/20'
  },
  error: {
    label: 'Failed',
    dot: 'bg-red-500',
    badge: 'text-red-500 bg-red-500/10 border-red-500/20'
  }
}

export function StatusBadge({ status }: { status: ProcessStatus }) {
  const { label, dot, badge } = STATUS_CONFIG[status]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-[10px] font-medium px-2 py-0.5 rounded-full border shrink-0',
        badge
      )}
    >
      <span className="relative flex size-1.5">
        {status === 'running' && (
          <span
            className={cn(
              'animate-ping absolute inline-flex h-full w-full rounded-full opacity-60',
              dot
            )}
          />
        )}
        <span className={cn('relative inline-flex rounded-full size-1.5', dot)} />
      </span>
      {label}
    </span>
  )
}
