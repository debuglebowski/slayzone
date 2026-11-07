import { Pin } from 'lucide-react'
import { cn } from '@slayzone/ui'
import type { TimelineItem } from '@slayzone/terminal/client'
import { useChatView } from './ChatViewContext'
import { pinnableRow } from './pinned-messages'

/** The row's pin state (null: it can't be pinned, or nothing can be yet). */
export function usePinnedRow(item: TimelineItem): { pinned: boolean; toggle: () => void } | null {
  const { pinnedMessages } = useChatView()
  const row = pinnedMessages ? pinnableRow(item) : null
  if (!pinnedMessages || !row) return null
  return { pinned: pinnedMessages.isPinned(row.key), toggle: () => pinnedMessages.toggle(item) }
}

/**
 * Pin / unpin a row. `reveal` = shown on hover / focus of the row (`group`)
 * while not pinned; a pinned row's button stays visible: it is the row's mark.
 */
export function PinToggleButton({
  item,
  className,
  reveal = false
}: {
  item: TimelineItem
  className?: string
  reveal?: boolean
}): React.JSX.Element | null {
  const state = usePinnedRow(item)
  if (!state) return null
  const label = state.pinned ? 'Unpin message' : 'Pin message'
  return (
    <button
      type="button"
      data-testid="chat-pin-toggle"
      aria-label={label}
      aria-pressed={state.pinned}
      title={label}
      onClick={state.toggle}
      className={cn(
        'flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring',
        state.pinned && 'text-primary',
        reveal &&
          !state.pinned &&
          'opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100',
        className
      )}
    >
      <Pin className={cn('size-3.5', state.pinned && 'fill-current')} aria-hidden="true" />
    </button>
  )
}

/** A pinned row's mark while its actions are hidden (clicking it unpins). */
export function PinnedMark({
  item,
  className
}: {
  item: TimelineItem
  className?: string
}): React.JSX.Element | null {
  const state = usePinnedRow(item)
  if (!state?.pinned) return null
  return (
    <button
      type="button"
      data-testid="chat-pinned-mark"
      aria-label="Pinned — unpin message"
      title="Pinned — click to unpin"
      onClick={state.toggle}
      className={cn(
        'flex size-6 items-center justify-center rounded text-primary hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring',
        className
      )}
    >
      <Pin className="size-3.5 fill-current" aria-hidden="true" />
    </button>
  )
}
