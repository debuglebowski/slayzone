import { GitBranch, Pencil, Undo2 } from 'lucide-react'
import { IconButton } from '@slayzone/ui'
import type { TimelineItem } from '@slayzone/terminal/client'
import { useChatView } from './ChatViewContext'

/**
 * Hover / focus actions on a past user message (chat A, plan 3.3): edit &
 * resend, rewind to here, fork from here. Only on messages the conversation
 * still holds; a message from before messages carried an id can't be named to
 * the CLI, so it says so instead.
 */
export function UserMessageActions({
  item
}: {
  item: Extract<TimelineItem, { kind: 'user-text' }>
}): React.JSX.Element | null {
  const { conversation } = useChatView()
  if (!conversation?.canRewind || item.parentToolUseId != null) return null
  const reveal =
    'opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100'
  if (!item.id) {
    return (
      <span
        className={`shrink-0 text-[10px] text-muted-foreground ${reveal}`}
        title="Edit, rewind and fork work on messages sent since they carry an id."
      >
        No rewind for older messages
      </span>
    )
  }
  const id = item.id
  if (!conversation.activeIds.has(id)) return null
  const message = { id, text: item.text }
  const disabled = conversation.busy
  return (
    <div
      data-testid="user-message-actions"
      className={`flex shrink-0 items-center gap-0.5 ${reveal}`}
    >
      <IconButton
        variant="ghost"
        className="size-6"
        aria-label="Edit & resend"
        title="Edit & resend"
        disabled={disabled}
        onClick={() => conversation.begin('edit', message)}
      >
        <Pencil className="size-3.5" />
      </IconButton>
      {conversation.lastActiveId !== id && (
        <IconButton
          variant="ghost"
          className="size-6"
          aria-label="Rewind to here"
          title="Rewind to here"
          disabled={disabled}
          onClick={() => conversation.begin('rewind', message)}
        >
          <Undo2 className="size-3.5" />
        </IconButton>
      )}
      {conversation.canFork && (
        <IconButton
          variant="ghost"
          className="size-6"
          aria-label="Fork from here"
          title="Fork from here"
          disabled={disabled}
          onClick={() => conversation.begin('fork', message)}
        >
          <GitBranch className="size-3.5" />
        </IconButton>
      )}
    </div>
  )
}
