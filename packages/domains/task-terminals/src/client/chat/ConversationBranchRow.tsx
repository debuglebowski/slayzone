import { GitBranch, History, Undo2 } from 'lucide-react'
import type { TimelineItem } from '@slayzone/terminal/client'
import { useChatProvider, useChatView } from './ChatViewContext'

/**
 * Where the conversation changed shape (rewind, fork, switch). What it no
 * longer holds stays in the timeline, folded above this divider: one click
 * shows it again.
 */
export function ConversationBranchRow({
  item
}: {
  item: Extract<TimelineItem, { kind: 'conversation-branch' }>
}): React.JSX.Element {
  const { branches } = useChatView()
  const provider = useChatProvider()
  const open = branches?.isOpen(item.id) ?? false
  const Icon = item.reason === 'forked' ? GitBranch : item.reason === 'rewound' ? Undo2 : History
  const label =
    item.reason === 'rewound'
      ? `Rewound: ${provider.agent} forgot what came after this point`
      : item.reason === 'forked'
        ? 'Forked into a new conversation'
        : item.reason === 'fork-failed'
          ? 'Fork failed: still the original conversation'
          : item.source === 'terminal'
            ? 'Continued from the terminal'
            : item.title
              ? `Resumed: ${item.title}`
              : 'Resumed an earlier conversation'
  const hiddenWhat =
    item.reason === 'switched'
      ? 'previous conversation'
      : item.reason === 'forked'
        ? 'original conversation'
        : 'rewound'
  return (
    <div
      data-testid="chat-branch"
      data-reason={item.reason}
      className="mx-4 my-2 flex items-center gap-2 text-[11px] text-muted-foreground"
    >
      <div className="h-px flex-1 bg-border" />
      <Icon className="size-3 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
      {item.hiddenCount > 0 && branches && (
        <button
          type="button"
          data-testid="chat-branch-toggle"
          className="shrink-0 rounded-sm px-1 text-foreground/80 hover:bg-accent hover:text-accent-foreground"
          onClick={() => branches.toggle(item.id)}
        >
          {open ? `Hide ${hiddenWhat}` : `Show ${hiddenWhat} (${item.hiddenCount})`}
        </button>
      )}
      <div className="h-px flex-1 bg-border" />
    </div>
  )
}
