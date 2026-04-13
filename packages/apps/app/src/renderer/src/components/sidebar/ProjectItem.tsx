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
import type { Project } from '@slayzone/projects/shared'

interface ProjectItemProps {
  project: Project
  selected: boolean
  onClick: () => void
  onSettings: () => void
  onDelete: () => void
  attentionCount: number
  badgeMode: 'none' | 'blob' | 'count'
}

export function ProjectItem({
  project,
  selected,
  onClick,
  onSettings,
  onDelete,
  attentionCount,
  badgeMode
}: ProjectItemProps) {
  const customLetters = project.icon_letters?.trim().toUpperCase()
  const fallbackLetters = project.name.slice(0, 2).toUpperCase()
  const letters = customLetters && customLetters.length > 0 ? customLetters : fallbackLetters
  const lettersClass = letters.length >= 5 ? 'text-[8px]' : letters.length > 2 ? 'text-[9px]' : 'text-xs'
  const iconSrc = project.icon_image_path
    ? `slz-file://${project.icon_image_path}?v=${encodeURIComponent(project.updated_at)}`
    : null
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: project.id })

  const style = {
    transform: transform ? CSS.Transform.toString({ ...transform, x: 0 }) : undefined,
    transition,
    opacity: isDragging ? 0.5 : undefined
  }

  return (
    <div ref={setNodeRef} style={style} className="relative">
      <Tooltip>
        <ContextMenu>
          <TooltipTrigger asChild>
            <ContextMenuTrigger asChild>
              <button
                onClick={onClick}
                className={cn(
                  'w-10 h-10 rounded-lg flex items-center justify-center overflow-hidden',
                  'font-semibold text-white transition-all',
                  !iconSrc && lettersClass,
                  selected && 'ring-2 ring-primary ring-offset-2 ring-offset-background'
                )}
                style={{ backgroundColor: project.color }}
                {...attributes}
                {...listeners}
              >
                {iconSrc ? (
                  <img src={iconSrc} alt="" className="w-full h-full object-cover" draggable={false} />
                ) : (
                  letters
                )}
              </button>
            </ContextMenuTrigger>
          </TooltipTrigger>
          <ContextMenuContent>
            <ContextMenuItem onSelect={onSettings}>Settings</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={onDelete} className="text-destructive">
              Delete
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        <TooltipContent side="right">{project.name}</TooltipContent>
      </Tooltip>
      {attentionCount > 0 && badgeMode === 'blob' && (
        <span
          className="absolute -top-1.5 -right-1.5 z-50 size-3 rounded-full bg-primary border-2 border-background pointer-events-none"
        />
      )}
      {attentionCount > 0 && badgeMode === 'count' && (
        <span
          className="absolute -top-1.5 -right-1.5 z-50 min-w-4 rounded-full bg-primary border-2 border-background px-1 text-[10px] font-semibold leading-4 text-center text-primary-foreground pointer-events-none"
        >
          {attentionCount}
        </span>
      )}
    </div>
  )
}
