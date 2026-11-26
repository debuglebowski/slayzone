import { cn } from './utils'

export type StatusTone = 'ok' | 'idle' | 'bad'

/** A state's tone as a dot: hubs, computers, a project's folder on a computer. */
export function StatusDot({ tone, className }: { tone: StatusTone; className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-tone={tone}
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        tone === 'ok'
          ? 'bg-green-500'
          : tone === 'bad'
            ? 'bg-destructive'
            : 'bg-muted-foreground/50',
        className
      )}
    />
  )
}
