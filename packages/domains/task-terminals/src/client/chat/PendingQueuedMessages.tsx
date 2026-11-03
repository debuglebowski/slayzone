import { userMessageAttachments } from '@slayzone/terminal-contracts'
import type { QueuedSubmission } from './queued-submissions'

export function PendingQueuedMessages({
  items = [],
  onRetry,
  onDismiss
}: {
  items?: QueuedSubmission[]
  onRetry: (id: string) => Promise<void>
  onDismiss?: (id: string) => Promise<void>
}) {
  if (!items.length) return null
  return (
    <div className="border-t px-3 py-2 text-xs" aria-label="Unconfirmed queued messages">
      {items.map((entry) => (
        <div key={entry.id} className="flex items-start gap-3 py-1">
          <div className="min-w-0 flex-1">
            <p className="whitespace-pre-wrap break-words line-clamp-2">
              {entry.original || entry.send || 'Attached files'}
            </p>
            {userMessageAttachments(entry.content).length > 0 && (
              <p className="text-muted-foreground">
                {userMessageAttachments(entry.content)
                  .map((file) => file.name)
                  .join(', ')}
              </p>
            )}
            <p className="text-muted-foreground" role="status">
              {entry.state === 'pending' ? 'Waiting for queue confirmation…' : entry.error}
            </p>
          </div>
          {entry.state === 'failed' && (
            <>
              <button
                type="button"
                className="shrink-0 rounded border px-2 py-1 hover:bg-accent"
                onClick={() => {
                  void onRetry(entry.id).catch(() => {
                    /* Pending copy retains the error. */
                  })
                }}
              >
                Retry
              </button>
              {onDismiss && (
                <button
                  type="button"
                  className="shrink-0 px-1 py-1 text-muted-foreground"
                  title="Remove local copy. Messages already accepted on the computer are not cancelled."
                  onClick={() => {
                    void onDismiss(entry.id).catch(() => {
                      /* Keep the local copy if deletion fails. */
                    })
                  }}
                >
                  Dismiss
                </button>
              )}
            </>
          )}
        </div>
      ))}
    </div>
  )
}
