import { motion } from 'framer-motion'
import { cn } from '@slayzone/ui'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@slayzone/ui'
import { Tooltip, TooltipTrigger, TooltipContent } from '@slayzone/ui'
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
  const abbrev = project.name.slice(0, 2).toUpperCase()

  return (
    <div className="relative">
      <Tooltip>
        <ContextMenu>
          <TooltipTrigger asChild>
            <ContextMenuTrigger asChild>
              <motion.button
                onClick={onClick}
                className={cn(
                  'w-10 h-10 rounded-lg flex items-center justify-center',
                  'text-xs font-semibold text-white transition-all',
                  selected && 'ring-2 ring-primary ring-offset-2 ring-offset-background'
                )}
                style={{ backgroundColor: project.color }}
                whileTap={{ scale: 0.95 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', stiffness: 1800, damping: 50 }}
              >
                {abbrev}
              </motion.button>
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
