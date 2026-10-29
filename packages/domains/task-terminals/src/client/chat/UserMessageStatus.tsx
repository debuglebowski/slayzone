import { AlertCircle, Check, Clock } from 'lucide-react'
import type { TimelineItem } from '@slayzone/terminal/client'
import { useChatView } from './ChatViewContext'

/**
 * Where a sent message is on its way to the agent, under its bubble. Quiet
 * once it is answered; a failure says why and offers Retry (same message id, so
 * it can never arrive twice).
 */
export function UserMessageStatus({
  item
}: {
  item: Extract<TimelineItem, { kind: 'user-text' }>
}): React.JSX.Element | null {
  const { retryMessage } = useChatView()
  const state = item.delivery
  if (!state || state === 'answered' || state === 'cancelled') return null
  if (state === 'failed') {
    return (
      <div
        data-delivery="failed"
        role="status"
        className="px-4 -mt-1 pb-1 flex justify-end items-center gap-1.5 text-[11px] text-destructive"
      >
        <AlertCircle className="size-3 shrink-0" />
        <span className="min-w-0 truncate" title={item.deliveryError}>
          Not sent{item.deliveryError ? `: ${item.deliveryError}` : ''}
        </span>
        {item.id && retryMessage ? (
          <button
            type="button"
            className="shrink-0 rounded px-1.5 py-0.5 font-medium text-foreground hover:bg-accent"
            onClick={() => retryMessage(item.id!)}
          >
            Retry
          </button>
        ) : null}
      </div>
    )
  }
  const label =
    state === 'delivered' ? 'Received' : state === 'sending' ? 'Sending…' : 'Waiting for the agent…'
  return (
    <div
      data-delivery={state}
      role="status"
      className="px-4 -mt-1 pb-1 flex justify-end items-center gap-1 text-[11px] text-muted-foreground"
    >
      {state === 'delivered' ? <Check className="size-3" /> : <Clock className="size-3" />}
      <span>{label}</span>
    </div>
  )
}
