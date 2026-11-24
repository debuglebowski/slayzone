import type { HubConnection } from '@slayzone/transport/client'
import { cn } from '@slayzone/ui'

export type StatusTone = 'ok' | 'idle' | 'bad'

/** Same tones as the hub/computer status in `HubCard` (`HubStatus`). */
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

export function toneOfConnection(connection: HubConnection | null): StatusTone {
  if (!connection) return 'idle'
  if (connection.status === 'open') return 'ok'
  return connection.error ? 'bad' : 'idle'
}
