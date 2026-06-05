import { GripVertical } from 'lucide-react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Switch, Tooltip, TooltipContent, TooltipTrigger } from '@slayzone/ui'
import type { GitTabId } from '@slayzone/task/shared'
import { GIT_TAB_LABELS } from '@slayzone/task/shared'

export function SortableGitTabRow({
  id,
  enabled,
  onToggle,
  locked,
  lockedHint
}: {
  id: GitTabId
  enabled: boolean
  onToggle: (next: boolean) => void
  locked?: boolean
  lockedHint?: string
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1
  }
  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-3 h-9 rounded-md border px-2"
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="shrink-0 flex items-center justify-center size-6 text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing touch-none"
        aria-label="Drag to reorder"
      >
        <GripVertical className="size-4" />
      </button>
      <span className="text-sm flex-1 min-w-0 truncate">{GIT_TAB_LABELS[id]}</span>
      {locked ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Switch disabled checked />
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">{lockedHint ?? 'Always visible'}</TooltipContent>
        </Tooltip>
      ) : (
        <Switch checked={enabled} onCheckedChange={onToggle} />
      )}
    </div>
  )
}
