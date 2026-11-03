import { useEffect, useState } from 'react'
import { CornerDownRight, GripVertical, Pencil, SendHorizonal, X as XIcon } from 'lucide-react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { cn, toast, Tooltip, TooltipContent, TooltipTrigger } from '@slayzone/ui'
import {
  userMessageAttachments,
  type ChatAttachment,
  type QueuedChatMessage
} from '@slayzone/terminal-contracts'
import { AttachmentChip } from './attachments/AttachmentChip'
import type { QueuedSubmission } from './queued-submissions'

/** How often an open editor renews its hold (the server's lapses after 30 s). */
export const HOLD_RENEW_MS = 10_000

/** The app's tooltip on a row control (the control itself is the trigger). */
function RowTip({ label, children }: { label: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  )
}

export interface ChatQueueListProps {
  items: QueuedChatMessage[]
  /** Edit + reorder (`editableQueue` capability); off → list + cancel, as before. */
  editable: boolean
  onRemove: (id: string) => Promise<void>
  onMove: (id: string, toIndex: number) => Promise<void>
  /** Hold a message while it is edited (and renew); false when it was already sent. */
  onHold: (id: string) => Promise<boolean>
  onRelease: (id: string) => Promise<void>
  /** Save an edit; false when the message was sent meanwhile. */
  onSave: (id: string, text: string, attachments: ChatAttachment[]) => Promise<boolean>
  /** An edit whose message was sent anyway: hand it to the composer. */
  onSaveGone: (text: string, attachments: ChatAttachment[]) => void
  /** "Stop & send": stop the turn and send this one next. Absent → no button. */
  onSendNow?: (id: string) => void
  /**
   * "Send now": the agent takes it after its current tool call, in
   * the running turn. Absent → no button (no turn runs, a prompt waits, or the
   * provider can't).
   */
  onSteer?: (id: string) => void
  /** A message with the agent (`steering`) can be taken back until it is picked up. */
  withdrawSteered?: boolean
  /**
   * Messages sent to the queue that the hub has not confirmed yet (saved on this
   * device first). Shown at once as ordinary rows at the end — no actions until
   * confirmed; one that failed says why, with Retry and Dismiss.
   */
  pending?: readonly QueuedSubmission[]
  onRetryPending?: (id: string) => Promise<void>
  onDismissPending?: (id: string) => Promise<void>
}

/** Renew `id`'s hold every HOLD_RENEW_MS until the returned stop is called. */
function keepHolding(id: string, onHold: (id: string) => Promise<boolean>): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const renew = (): void => {
    timer = setTimeout(() => {
      void onHold(id)
      renew()
    }, HOLD_RENEW_MS)
  }
  renew()
  return () => {
    if (timer) clearTimeout(timer)
  }
}

interface Editing {
  id: string
  text: string
  attachments: ChatAttachment[]
}

/**
 * The "Up next" queue above the composer. With `editable`: drag (or Alt+↑/↓)
 * to reorder, the pencil to edit in place — the message is held while edited,
 * so a turn ending meanwhile does not send the old text.
 */
export function ChatQueueList(props: ChatQueueListProps): React.JSX.Element | null {
  const { items, editable, onMove, onHold, onRelease } = props
  const [editing, setEditing] = useState<Editing | null>(null)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  // While a message is being edited: keep it held; release it when the editor
  // closes (saved, cancelled) or goes away.
  const editingId = editing?.id ?? null
  useEffect(() => {
    if (!editingId) return
    const stop = keepHolding(editingId, onHold)
    return () => {
      stop()
      void onRelease(editingId)
    }
  }, [editingId, onHold, onRelease])

  // Once the hub lists one, its confirmed row stands for it.
  const listed = new Set(items.map((m) => m.id))
  const unconfirmed = (props.pending ?? []).filter((p) => !listed.has(p.id))
  if (items.length === 0 && unconfirmed.length === 0) return null

  const startEdit = async (msg: QueuedChatMessage): Promise<void> => {
    if (!(await onHold(msg.id))) {
      toast('That message was already sent — it can no longer be edited.')
      return
    }
    setEditing({
      id: msg.id,
      text: msg.original,
      attachments: userMessageAttachments(msg.content ?? [])
    })
  }

  const save = async (): Promise<void> => {
    if (!editing) return
    const text = editing.text.trim()
    if (!text && editing.attachments.length === 0) return
    const saved = await props.onSave(editing.id, text, editing.attachments)
    if (!saved) {
      props.onSaveGone(text, editing.attachments)
      toast('That message was already sent — your edit is in the message box.')
    }
    setEditing(null)
  }

  const onDragEnd = (e: DragEndEvent): void => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const to = items.findIndex((m) => m.id === over.id)
    if (to >= 0) void onMove(String(active.id), to)
  }

  const rows = items.map((msg, i) => (
    <QueueRow
      key={msg.id}
      {...props}
      msg={msg}
      index={i}
      count={items.length}
      sortable={editable && editing?.id !== msg.id && !msg.steering}
      editable={editable}
      editing={editing?.id === msg.id ? editing : null}
      onEditChange={(next) => setEditing(next)}
      onStartEdit={() => void startEdit(msg)}
      onSaveEdit={() => void save()}
      onCancelEdit={() => setEditing(null)}
    />
  ))

  const pendingRows = unconfirmed.map((entry, i) => (
    <PendingRow
      key={entry.id}
      entry={entry}
      index={items.length + i}
      onRetry={props.onRetryPending}
      onDismiss={props.onDismissPending}
    />
  ))

  return (
    <div className="mb-2" data-testid="chat-queue">
      <div className="px-1 mb-1 text-[10px] uppercase tracking-wide text-muted-foreground/60">
        Up next · {items.length + unconfirmed.length}
      </div>
      {editable ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={items.map((m) => m.id)} strategy={verticalListSortingStrategy}>
            <ul className="divide-y divide-border/40 rounded-2xl border border-border/40 overflow-hidden">
              {rows}
              {pendingRows}
            </ul>
          </SortableContext>
        </DndContext>
      ) : (
        <ul className="divide-y divide-border/40 rounded-2xl border border-border/40 overflow-hidden">
          {rows}
          {pendingRows}
        </ul>
      )}
    </div>
  )
}

interface QueueRowProps extends ChatQueueListProps {
  msg: QueuedChatMessage
  index: number
  count: number
  sortable: boolean
  editing: Editing | null
  onEditChange: (next: Editing) => void
  onStartEdit: () => void
  onSaveEdit: () => void
  onCancelEdit: () => void
}

function QueueRow(props: QueueRowProps): React.JSX.Element {
  // useSortable needs a SortableContext: only sortable rows call it.
  return props.sortable ? <SortableQueueRow {...props} /> : <QueueRowBody {...props} />
}

function SortableQueueRow(props: QueueRowProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.msg.id
  })
  return (
    <QueueRowBody
      {...props}
      rowRef={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1
      }}
      handle={
        <RowTip label="Drag to reorder (or Alt+↑ / Alt+↓)">
          <button
            type="button"
            {...attributes}
            {...listeners}
            className="shrink-0 -ml-1 flex items-center justify-center size-5 text-muted-foreground/50 hover:text-foreground cursor-grab active:cursor-grabbing touch-none"
            aria-label="Drag to reorder"
          >
            <GripVertical className="size-3" />
          </button>
        </RowTip>
      }
    />
  )
}

function QueueRowBody({
  msg,
  index,
  count,
  editable,
  editing,
  onEditChange,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onRemove,
  onMove,
  onSendNow,
  onSteer,
  withdrawSteered,
  rowRef,
  style,
  handle
}: QueueRowProps & {
  rowRef?: (el: HTMLElement | null) => void
  style?: React.CSSProperties
  handle?: React.ReactNode
}): React.JSX.Element {
  const files = userMessageAttachments(msg.content ?? [])
  const label = (
    <span className="flex-1 min-w-0 truncate">
      {files.length > 0 && (
        <span className="mr-1.5 text-muted-foreground/70">
          {files.map((f) => f.name).join(', ')}
        </span>
      )}
      {msg.send}
    </span>
  )
  if (msg.steering) {
    // Added to the running turn: the agent takes it after its current tool call.
    return (
      <li
        ref={rowRef}
        style={style}
        data-testid="chat-queue-item"
        data-steering="true"
        className="group flex items-center gap-2 px-3 py-1.5 text-xs bg-muted/20"
      >
        <span className="shrink-0 text-muted-foreground/50 font-mono text-[10px] tabular-nums">
          {index + 1}.
        </span>
        {label}
        <RowTip label="Sent: the agent reads it after its current step">
          <span className="shrink-0 text-[10px] text-muted-foreground animate-pulse">
            With agent…
          </span>
        </RowTip>
        {withdrawSteered && (
          <RowTip label="Take it back before the agent reads it">
            <button
              type="button"
              onClick={() => void onRemove(msg.id)}
              className="shrink-0 rounded p-0.5 opacity-50 hover:opacity-100 hover:bg-destructive/15 hover:text-destructive transition-colors"
              aria-label="Take back from the agent"
            >
              <XIcon className="size-3" />
            </button>
          </RowTip>
        )}
      </li>
    )
  }
  if (editing) {
    return (
      <li
        ref={rowRef}
        style={style}
        className="px-3 py-2 bg-muted/30 space-y-1.5"
        data-testid="chat-queue-item"
      >
        {editing.attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {editing.attachments.map((a, i) => (
              <AttachmentChip
                key={`${a.artifactId}-${i}`}
                attachment={a}
                onRemove={() =>
                  onEditChange({
                    ...editing,
                    attachments: editing.attachments.filter((_, idx) => idx !== i)
                  })
                }
              />
            ))}
          </div>
        )}
        <textarea
          aria-label="Edit queued message"
          autoFocus
          value={editing.text}
          rows={Math.min(6, Math.max(1, editing.text.split('\n').length))}
          onChange={(e) => onEditChange({ ...editing, text: e.target.value })}
          onKeyDown={(e) => {
            // Never the panel's keys (Esc there stops the running turn).
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              onCancelEdit()
            } else if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
              e.preventDefault()
              e.stopPropagation()
              onSaveEdit()
            }
          }}
          className="w-full resize-none rounded-md bg-background px-2 py-1 text-xs text-foreground outline-none ring-1 ring-border/60 focus:ring-ring"
        />
        <div className="text-[10px] text-muted-foreground/60">Enter to save · Esc to cancel</div>
      </li>
    )
  }
  return (
    <li
      ref={rowRef}
      style={style}
      tabIndex={editable ? 0 : undefined}
      data-testid="chat-queue-item"
      onKeyDown={(e) => {
        if (!editable || !e.altKey || e.target !== e.currentTarget) return
        if (e.key === 'ArrowUp' && index > 0) {
          e.preventDefault()
          void onMove(msg.id, index - 1)
        } else if (e.key === 'ArrowDown' && index < count - 1) {
          e.preventDefault()
          void onMove(msg.id, index + 1)
        }
      }}
      className={cn(
        'group flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted/30 outline-none',
        editable && 'focus-visible:bg-muted/40'
      )}
    >
      {handle}
      <span className="shrink-0 text-muted-foreground/50 font-mono text-[10px] tabular-nums">
        {index + 1}.
      </span>
      {label}
      {onSteer && (
        <RowTip label="Send now: the agent reads it after its current step">
          <button
            type="button"
            onClick={() => onSteer(msg.id)}
            className="shrink-0 rounded p-0.5 opacity-50 hover:opacity-100 hover:bg-muted transition-colors"
            aria-label="Send now"
          >
            <CornerDownRight className="size-3" />
          </button>
        </RowTip>
      )}
      {onSendNow && (
        <RowTip label="Stop the agent and send this next">
          <button
            type="button"
            onClick={() => onSendNow(msg.id)}
            className="shrink-0 rounded p-0.5 opacity-50 hover:opacity-100 hover:bg-muted transition-colors"
            aria-label="Stop & send"
          >
            <SendHorizonal className="size-3" />
          </button>
        </RowTip>
      )}
      {editable && (
        <RowTip label="Edit">
          <button
            type="button"
            onClick={onStartEdit}
            className="shrink-0 rounded p-0.5 opacity-50 hover:opacity-100 hover:bg-muted transition-colors"
            aria-label="Edit queued message"
          >
            <Pencil className="size-3" />
          </button>
        </RowTip>
      )}
      <RowTip label="Remove from the queue">
        <button
          type="button"
          onClick={() => void onRemove(msg.id)}
          className="shrink-0 rounded p-0.5 opacity-50 hover:opacity-100 hover:bg-destructive/15 hover:text-destructive transition-colors"
          aria-label="Cancel queued message"
        >
          <XIcon className="size-3" />
        </button>
      </RowTip>
    </li>
  )
}

/**
 * A message the hub has not confirmed yet: an ordinary row, without actions (it
 * has no queue entry to act on until the hub confirms it). A failed one says why.
 */
function PendingRow({
  entry,
  index,
  onRetry,
  onDismiss
}: {
  entry: QueuedSubmission
  index: number
  onRetry?: (id: string) => Promise<void>
  onDismiss?: (id: string) => Promise<void>
}): React.JSX.Element {
  const files = userMessageAttachments(entry.content)
  const failed = entry.state === 'failed'
  return (
    <li
      data-testid="chat-queue-item"
      data-unconfirmed="true"
      className="flex items-center gap-2 px-3 py-1.5 text-xs"
    >
      <span className="shrink-0 text-muted-foreground/50 font-mono text-[10px] tabular-nums">
        {index + 1}.
      </span>
      <span className="flex-1 min-w-0">
        <span className="block truncate">
          {files.length > 0 && (
            <span className="mr-1.5 text-muted-foreground/70">
              {files.map((f) => f.name).join(', ')}
            </span>
          )}
          {entry.original || entry.send}
        </span>
        {failed && entry.error && (
          <span className="block truncate text-[10px] text-destructive" role="status">
            {entry.error}
          </span>
        )}
      </span>
      {failed && onRetry && (
        <RowTip label="Send it to the queue again">
          <button
            type="button"
            onClick={() => void onRetry(entry.id).catch(() => undefined)}
            className="shrink-0 rounded px-1.5 py-0.5 text-[10px] hover:bg-muted transition-colors"
          >
            Retry
          </button>
        </RowTip>
      )}
      {failed && onDismiss && (
        <RowTip label="Remove this copy. A message the computer already took stays queued.">
          <button
            type="button"
            onClick={() => void onDismiss(entry.id).catch(() => undefined)}
            className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted transition-colors"
          >
            Dismiss
          </button>
        </RowTip>
      )}
    </li>
  )
}
