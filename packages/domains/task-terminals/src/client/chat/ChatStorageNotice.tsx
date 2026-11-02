import { LoaderCircle, MonitorOff } from 'lucide-react'
import { chatAvailabilityMessage, type ChatAvailability } from '@slayzone/terminal-contracts'
export function ChatStorageNotice({
  status,
  error = null,
  onRetry
}: {
  status: ChatAvailability | null
  error?: string | null
  onRetry: () => void | Promise<void>
}) {
  const message = status ? chatAvailabilityMessage(status) : null
  if (!message && !error) return null
  const pending = !error && status?.state === 'migrating'
  return (
    <div role="status" className="flex items-start gap-2 border-b bg-muted/40 px-3 py-2 text-xs">
      {pending ? (
        <LoaderCircle
          aria-hidden
          className="mt-0.5 size-4 shrink-0 animate-spin motion-reduce:animate-none"
        />
      ) : (
        <MonitorOff aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1">
        <p className="font-medium">{error ? 'Chat unavailable' : message?.title}</p>
        {message?.detail && <p className="text-muted-foreground">{message.detail}</p>}
        {error && <p className="text-destructive">{error}</p>}
      </div>
      {status?.state !== 'deleted' && (
        <button
          type="button"
          className="shrink-0 rounded border px-2 py-1 hover:bg-accent"
          onClick={() => {
            void onRetry()
          }}
        >
          Retry
        </button>
      )}
    </div>
  )
}
