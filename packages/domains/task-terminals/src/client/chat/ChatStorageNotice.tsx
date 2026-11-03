import { LoaderCircle, MonitorOff, RotateCw } from 'lucide-react'
import { chatAvailabilityMessage, type ChatAvailability } from '@slayzone/terminal-contracts'
import { Button } from '@slayzone/ui'

/**
 * An exceptional storage state (offline, migrating, …) above a chat that still
 * works or waits. A chat that failed to open shows `ChatOpenFailure` instead.
 */
export function ChatStorageNotice({
  status,
  onRetry
}: {
  status: ChatAvailability | null
  onRetry: () => void | Promise<void>
}) {
  const message = status ? chatAvailabilityMessage(status) : null
  if (!message) return null
  const pending = status?.state === 'migrating'
  return (
    <div
      role="status"
      data-testid="chat-storage-notice"
      className="flex items-start gap-3 border-b bg-muted/40 px-4 py-3 text-xs"
    >
      {pending ? (
        <LoaderCircle
          aria-hidden
          className="mt-px size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
        />
      ) : (
        <MonitorOff aria-hidden className="mt-px size-4 shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium leading-4 text-foreground">{message.title}</p>
        <p className="text-muted-foreground">{message.detail}</p>
      </div>
      {status?.state !== 'deleted' && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="-my-0.5 h-7 gap-1.5 px-2.5 text-xs"
          onClick={() => {
            void onRetry()
          }}
        >
          <RotateCw aria-hidden className="size-3" />
          Retry
        </Button>
      )}
    </div>
  )
}
