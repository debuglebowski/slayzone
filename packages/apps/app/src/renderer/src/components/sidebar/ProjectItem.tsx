import { cn } from '@slayzone/ui'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@slayzone/ui'
import { Tooltip, TooltipTrigger, TooltipContent } from '@slayzone/ui'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { FolderPlus } from 'lucide-react'
import type { Project } from '@slayzone/projects/shared'
import { ProjectAvatar } from './ProjectAvatar'

interface ProjectItemProps {
  project: Project
  selected: boolean
  onClick: () => void
  onSettings: () => void
  onDelete: () => void
  idleCount?: number
  /** Sortable id override (e.g. `top-project:<id>` / `member:<id>`). Defaults to project id. */
  sortableId?: string
  /** Drag data attached to the sortable (read by the rail's drop logic). */
  dragData?: Record<string, unknown>
  /** When set, adds a "Remove from group" context-menu item (member tiles). */
  onRemoveFromGroup?: () => void
  /** Ring the tile while a dragged project hovers its center (→ create folder). */
  mergeHighlight?: boolean
}

export function ProjectItem({
  project,
  selected,
  onClick,
  onSettings,
  onDelete,
  idleCount = 0,
  sortableId,
  dragData,
  onRemoveFromGroup,
  mergeHighlight
}: ProjectItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sortableId ?? project.id,
    data: dragData
  })

  const style = {
    // Stay put while dragging — the DragOverlay renders the moving copy and the
    // original slot shows an explicit placeholder below. Siblings don't shift
    // (no-op sort strategy in the rail).
    transform: isDragging
      ? undefined
      : transform
        ? CSS.Transform.toString({ ...transform, x: 0 })
        : undefined,
    transition
  }

  if (isDragging) {
    return (
      <div ref={setNodeRef} style={style} className="relative">
        <div className="w-10 h-10 rounded-lg border-2 border-dashed border-primary/50 bg-primary/5" />
      </div>
    )
  }

  return (
    <div ref={setNodeRef} style={style} className="group/proj relative">
      {/* Discord-style active indicator: white pill in the left gutter.
          Full height when selected, short pill on hover, hidden otherwise. */}
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute -left-4 top-1/2 z-30 w-1 -translate-y-1/2 rounded-r-full bg-foreground transition-all duration-200 ease-out',
          selected ? 'h-9' : 'h-0 group-hover/proj:h-5'
        )}
      />
      <Tooltip>
        <ContextMenu>
          <TooltipTrigger asChild>
            <ContextMenuTrigger asChild>
              <button
                onClick={onClick}
                className={cn(
                  'relative w-10 h-10 rounded-lg transition-all',
                  // Selected state shown by the Discord-style left pill (above),
                  // not a ring. No ring-offset on merge — offset pushes the ring
                  // outside the narrow rail and gets clipped to "corners".
                  // Inset-style fill is the real indicator (shows through the
                  // translucent drag preview).
                  mergeHighlight && 'ring-2 ring-primary'
                )}
                {...attributes}
                {...listeners}
              >
                <ProjectAvatar project={project} className="w-full h-full rounded-lg" />
                {mergeHighlight && (
                  <>
                    <span className="absolute inset-0 rounded-lg bg-primary/40" />
                    {/* Corner badge stays visible beyond the cursor's drag chip. */}
                    <span className="absolute -top-1.5 -right-1.5 z-50 flex items-center justify-center rounded-full bg-primary p-1 text-primary-foreground ring-2 ring-background">
                      <FolderPlus className="size-3" />
                    </span>
                  </>
                )}
              </button>
            </ContextMenuTrigger>
          </TooltipTrigger>
          <ContextMenuContent>
            <ContextMenuItem onSelect={onSettings}>Settings</ContextMenuItem>
            {onRemoveFromGroup && (
              <ContextMenuItem onSelect={onRemoveFromGroup}>Remove from group</ContextMenuItem>
            )}
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={onDelete} className="text-destructive">
              Delete
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        <TooltipContent side="right">{project.name}</TooltipContent>
      </Tooltip>
      {idleCount > 0 && (
        <span
          aria-label={`${idleCount} idle agent${idleCount === 1 ? '' : 's'}`}
          className="absolute -top-1.5 -right-1.5 z-50 min-w-4 rounded-full bg-primary border-2 border-background px-1 text-[10px] font-semibold leading-4 text-center text-primary-foreground pointer-events-none"
        >
          {idleCount}
        </span>
      )}
    </div>
  )
}
