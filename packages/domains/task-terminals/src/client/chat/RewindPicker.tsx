import { useMemo } from 'react'
import { CornerUpLeft, GitFork } from 'lucide-react'
import {
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  DialogDescription,
  DialogTitle
} from '@slayzone/ui'
import type { TimelinePageSummary } from '@slayzone/terminal/client'
import type { ConversationActionsView } from './useConversationActions'
import { useChatProvider } from './ChatViewContext'

/** Esc Esc / "Rewind…" pick a message to edit & resend; "Fork from a message…" to fork. */
export type RewindPickerKind = 'edit' | 'fork'

const COPY: Record<RewindPickerKind, { title: string; what: (agent: string) => string }> = {
  edit: {
    title: 'Rewind to before a message',
    what: (agent) =>
      `${agent} forgets the message and everything after it; its text comes back into the message box.`
  },
  fork: {
    title: 'Fork from a message',
    what: () =>
      'A new conversation with everything up to that message’s answer; this one stays as it is.'
  }
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > 120 ? `${line.slice(0, 120)}…` : line
}

function ago(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}

/**
 * The TUI's message selector: the conversation's messages, newest first,
 * filterable. Picking one starts the action on it (`view.begin`); its dialog
 * then asks what to restore.
 */
export function RewindPicker({
  kind,
  activeUsers,
  view,
  onClose
}: {
  kind: RewindPickerKind | null
  /** The user messages the conversation still holds, oldest first (`activeUserRows`). */
  activeUsers: TimelinePageSummary['users']
  view: ConversationActionsView
  onClose: () => void
}) {
  const messages = useMemo(() => {
    const out: Array<{ id: string; text: string; timestamp: number }> = []
    for (const { item } of activeUsers) {
      if (!item.id || !view.activeIds.has(item.id)) continue
      out.push({ id: item.id, text: item.text, timestamp: item.timestamp })
    }
    return out.reverse()
  }, [activeUsers, view.activeIds])

  const provider = useChatProvider()
  const copy = kind ? COPY[kind] : null
  const Icon = kind === 'fork' ? GitFork : CornerUpLeft
  return (
    <CommandDialog
      open={kind !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      {copy && (
        <>
          <div className="px-3 pt-3">
            <DialogTitle className="text-sm">{copy.title}</DialogTitle>
            <DialogDescription className="text-xs">{copy.what(provider.agent)}</DialogDescription>
          </div>
          <CommandInput data-testid="rewind-picker-input" placeholder="Search messages…" />
          <CommandList>
            <CommandEmpty>No messages.</CommandEmpty>
            {messages.map((m) => (
              <CommandItem
                key={m.id}
                value={`${m.id} ${m.text}`}
                data-testid="rewind-picker-item"
                data-message-id={m.id}
                onSelect={() => {
                  onClose()
                  if (kind) view.begin(kind, { id: m.id, text: m.text })
                }}
              >
                <Icon className="text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{firstLine(m.text)}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {ago(m.timestamp)}
                </span>
              </CommandItem>
            ))}
          </CommandList>
        </>
      )}
    </CommandDialog>
  )
}
