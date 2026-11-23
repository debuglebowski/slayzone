import { branchLabel, branchToggleLabel } from '@slayzone/terminal/chat-presentation'
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
  const label = branchLabel(item, provider.agent)
  const toggle = branchToggleLabel(item, open)
  return (
    <div
      data-testid="chat-branch"
      data-reason={item.reason}
      className="mx-4 my-2 flex items-center gap-2 text-2xs text-muted-foreground"
    >
      <div className="h-px flex-1 bg-border" />
      <Icon className="size-3 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
      {toggle && branches && (
        <button
          type="button"
          data-testid="chat-branch-toggle"
          className="shrink-0 rounded-sm px-1 text-foreground/80 hover:bg-accent hover:text-accent-foreground"
          onClick={() => branches.toggle(item.id)}
        >
          {toggle}
        </button>
      )}
      <div className="h-px flex-1 bg-border" />
    </div>
  )
}
