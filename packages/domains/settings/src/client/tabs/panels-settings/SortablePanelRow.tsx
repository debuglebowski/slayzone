import { ChevronRight, GripVertical } from 'lucide-react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Switch, Tooltip, TooltipContent, TooltipTrigger } from '@slayzone/ui'
import type { PanelRowDescriptor } from './panels-settings.types'

export function SortablePanelRow({ id, descriptor }: { id: string; descriptor: PanelRowDescriptor }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1
  }
  const Icon = descriptor.icon
  return (
    <div
      ref={setNodeRef}
      style={style}
      role={descriptor.onClick ? 'button' : undefined}
      tabIndex={descriptor.onClick ? 0 : undefined}
      onClick={descriptor.onClick}
      onKeyDown={
        descriptor.onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                descriptor.onClick?.()
              }
            }
          : undefined
      }
      className={`flex items-center gap-3 h-11 rounded-lg border bg-card px-2 w-full text-left transition-colors ${
        descriptor.onClick ? 'cursor-pointer hover:bg-accent/30' : ''
      }`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="shrink-0 flex items-center justify-center size-6 text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing touch-none"
        aria-label="Drag to reorder"
        onClick={(e) => e.stopPropagation()}
      >
        <GripVertical className="size-4" />
      </button>
      <div className="flex items-center gap-3 flex-1 min-w-0 text-left">
        <Icon className="size-4 shrink-0" />
        <span className="text-sm font-medium truncate">{descriptor.label}</span>
        {descriptor.webSubtitle && (
          <span className="text-xs text-muted-foreground truncate flex-1">
            {descriptor.webSubtitle}
          </span>
        )}
      </div>
      {descriptor.webSubtitle && (
        <span className="shrink-0 px-1.5 py-0.5 rounded-full border border-border text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
          External
        </span>
      )}
      {descriptor.sizeLabel && (
        <span className="shrink-0 w-16 text-center px-1.5 py-0.5 rounded-full border border-border text-[10px] font-medium text-muted-foreground tabular-nums">
          {descriptor.sizeLabel}
        </span>
      )}
      <div
        className="flex items-center gap-5 shrink-0 pr-2"
        onClick={(e) => e.stopPropagation()}
      >
        {descriptor.homeToggle ? (
          <Switch
            checked={descriptor.homeToggle.enabled}
            onCheckedChange={descriptor.homeToggle.onChange}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Switch disabled checked={false} onClick={(e) => e.stopPropagation()} />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">Task-only panel</TooltipContent>
          </Tooltip>
        )}
        {descriptor.taskToggle ? (
          <Switch
            checked={descriptor.taskToggle.enabled}
            onCheckedChange={descriptor.taskToggle.onChange}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="w-8" />
        )}
      </div>
      {descriptor.onClick ? (
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <span className="w-3.5" />
      )}
    </div>
  )
}
