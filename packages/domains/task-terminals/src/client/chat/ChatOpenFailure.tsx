import { useState } from 'react'
import { CircleAlert, RotateCw } from 'lucide-react'
import { chatAvailabilityMessage, type ChatAvailability } from '@slayzone/terminal-contracts'
import { Button, cn } from '@slayzone/ui'

/**
 * The chat could not be opened. Takes the composer's place (nothing can be
 * sent): centered over an empty timeline, or below history that did load.
 * A storage state (offline, migrating, …) titles it when there is one; the raw
 * cause stays behind "Details".
 */
export function ChatOpenFailure({
  status,
  error,
  placement,
  onRetry
}: {
  status: ChatAvailability | null
  error: string
  /** `center`: no history on screen. `bottom`: history stays readable above. */
  placement: 'center' | 'bottom'
  onRetry: () => void | Promise<void>
}) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const message = status ? chatAvailabilityMessage(status) : null
  return (
    <div
      role="status"
      data-testid="chat-open-failure"
      data-placement={placement}
      className={cn(
        'flex flex-col items-center gap-2.5 px-6 text-center',
        placement === 'center'
          ? 'absolute inset-0 z-20 justify-center bg-background'
          : 'shrink-0 border-t py-5'
      )}
    >
      <CircleAlert aria-hidden className="size-5 text-destructive" />
      <p className="text-sm font-medium text-foreground">
        {message?.title ?? 'Couldn’t open this chat'}
      </p>
      {message?.detail && (
        <p className="max-w-sm text-xs text-muted-foreground">{message.detail}</p>
      )}
      <div className="flex items-center gap-3">
        {status?.state !== 'deleted' && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2.5 text-xs"
            onClick={() => {
              void onRetry()
            }}
          >
            <RotateCw aria-hidden className="size-3" />
            Retry
          </Button>
        )}
        <button
          type="button"
          aria-expanded={detailsOpen}
          className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          onClick={() => setDetailsOpen(!detailsOpen)}
        >
          {detailsOpen ? 'Hide details' : 'Details'}
        </button>
      </div>
      {detailsOpen && (
        <p className="max-w-sm select-text break-words rounded-md border bg-muted/40 px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground">
          {error}
        </p>
      )}
    </div>
  )
}
