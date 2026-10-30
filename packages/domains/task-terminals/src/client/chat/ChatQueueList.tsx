import { useEffect, useState } from 'react'
import { GripVertical, Pencil, SendHorizonal, X as XIcon } from 'lucide-react'
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
import { cn, toast } from '@slayzone/ui'
import {
  userMessageAttachments,
  type ChatAttachment,
  type QueuedChatMessage
} from '@slayzone/terminal-contracts'
import { AttachmentChip } from './attachments/AttachmentChip'

/** How often an open editor renews its hold (the server's lapses after 30 s). */
export const HOLD_RENEW_MS = 10_000

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
  /** Stop the turn and send this one next. Absent → no button. */
  onSendNow?: (id: string) => void
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

  if (items.length === 0) return null

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
      sortable={editable && editing?.id !== msg.id}
      editable={editable}
      editing={editing?.id === msg.id ? editing : null}
      onEditChange={(next) => setEditing(next)}
      onStartEdit={() => void startEdit(msg)}
      onSaveEdit={() => void save()}
      onCancelEdit={() => setEditing(null)}
    />
  ))

  return (
    <div className="mb-2" data-testid="chat-queue">
      <div className="px-1 mb-1 text-[10px] uppercase tracking-wide text-muted-foreground/60">
        Up next · {items.length}
      </div>
      {editable ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={items.map((m) => m.id)} strategy={verticalListSortingStrategy}>
            <ul className="divide-y divide-border/40 rounded-md border border-border/40 overflow-hidden">
              {rows}
            </ul>
          </SortableContext>
        </DndContext>
      ) : (
        <ul className="divide-y divide-border/40 rounded-md border border-border/40 overflow-hidden">
          {rows}
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
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="shrink-0 -ml-1 flex items-center justify-center size-5 text-muted-foreground/50 hover:text-foreground cursor-grab active:cursor-grabbing touch-none"
          aria-label="Drag to reorder"
        >
          <GripVertical className="size-3" />
        </button>
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
  rowRef,
  style,
  handle
}: QueueRowProps & {
  rowRef?: (el: HTMLElement | null) => void
  style?: React.CSSProperties
  handle?: React.ReactNode
}): React.JSX.Element {
  const files = userMessageAttachments(msg.content ?? [])
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
      <span className="flex-1 min-w-0 truncate">
        {files.length > 0 && (
          <span className="mr-1.5 text-muted-foreground/70">
            {files.map((f) => f.name).join(', ')}
          </span>
        )}
        {msg.send}
      </span>
      {onSendNow && (
        <button
          type="button"
          onClick={() => onSendNow(msg.id)}
          className="shrink-0 rounded p-0.5 opacity-50 hover:opacity-100 hover:bg-muted transition-colors"
          aria-label="Send now"
          title="Stop the current turn and send this next"
        >
          <SendHorizonal className="size-3" />
        </button>
      )}
      {editable && (
        <button
          type="button"
          onClick={onStartEdit}
          className="shrink-0 rounded p-0.5 opacity-50 hover:opacity-100 hover:bg-muted transition-colors"
          aria-label="Edit queued message"
          title="Edit"
        >
          <Pencil className="size-3" />
        </button>
      )}
      <button
        type="button"
        onClick={() => void onRemove(msg.id)}
        className="shrink-0 rounded p-0.5 opacity-50 hover:opacity-100 hover:bg-destructive/15 hover:text-destructive transition-colors"
        aria-label="Cancel queued message"
        title="Cancel"
      >
        <XIcon className="size-3" />
      </button>
    </li>
  )
}
