import React, { useState } from 'react'
import { Circle, GripVertical } from 'lucide-react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  cn,
  getColumnStatusStyle
} from '@slayzone/ui'
import { PtyProgressDot } from '@slayzone/terminal'
import { isTerminalStatus } from '@slayzone/projects/shared'
import type { Project } from '@slayzone/projects/shared'
import type { Task } from '@slayzone/task/shared'

export function TaskOverviewRow({
  sub,
  columns,
  statusOptions,
  onNavigate,
  onUpdate,
  onDelete,
  dragHandle,
  rowRef,
  rowStyle,
  isDragging
}: {
  sub: Task
  columns?: Project['columns_config']
  statusOptions: Array<{ value: string; label: string }>
  onNavigate?: (id: string) => void
  onUpdate: (id: string, updates: Record<string, unknown>) => void
  onDelete?: (id: string) => void
  dragHandle?: React.ReactNode
  rowRef?: (node: HTMLElement | null) => void
  rowStyle?: React.CSSProperties
  isDragging?: boolean
}): React.JSX.Element {
  const statusStyle = getColumnStatusStyle(sub.status, columns)
  const StatusIcon = statusStyle?.icon
  const [statusOpen, setStatusOpen] = useState(false)

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={rowRef}
          style={rowStyle}
          className={cn(
            'relative flex items-center gap-2 py-1 px-1 rounded cursor-pointer hover:bg-muted/50 group select-none',
            isDragging && 'opacity-50'
          )}
        >
          {dragHandle}
          <Popover open={statusOpen} onOpenChange={setStatusOpen}>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label={`Status: ${statusStyle?.label ?? sub.status}`}
                    onClick={(e) => e.stopPropagation()}
                    className="shrink-0 cursor-pointer transition-opacity hover:opacity-70"
                  >
                    {StatusIcon && (
                      <StatusIcon className={cn('size-3.5', statusStyle?.iconClass)} />
                    )}
                  </button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent>
                {statusStyle?.label ?? sub.status} — {Math.round(sub.progress ?? 0)}% complete
              </TooltipContent>
            </Tooltip>
            <PopoverContent className="w-44 p-1" align="start" onClick={(e) => e.stopPropagation()}>
              {statusOptions.map((opt) => {
                const optStyle = getColumnStatusStyle(opt.value, columns)
                const OptIcon = optStyle?.icon ?? Circle
                const isCurrent = opt.value === sub.status
                return (
                  <button
                    key={opt.value}
                    type="button"
                    className={cn(
                      'flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm cursor-pointer hover:bg-accent',
                      isCurrent && 'bg-accent font-medium'
                    )}
                    onClick={() => {
                      onUpdate(sub.id, { status: opt.value })
                      setStatusOpen(false)
                    }}
                  >
                    <OptIcon className={cn('size-4', optStyle?.iconClass)} />
                    {opt.label}
                  </button>
                )
              })}
            </PopoverContent>
          </Popover>
          <span
            className={cn(
              'text-xs flex-1 truncate',
              isTerminalStatus(sub.status, columns ?? null) && 'line-through text-muted-foreground'
            )}
            onClick={() => onNavigate?.(sub.id)}
          >
            {sub.title}
          </span>
          <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
            <PtyProgressDot sessionId={`${sub.id}:${sub.id}`} progress={sub.progress} alwaysShow />
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onSelect={() => onNavigate?.(sub.id)}>Open</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger>Status</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuRadioGroup
              value={sub.status}
              onValueChange={(v) => onUpdate(sub.id, { status: v })}
            >
              {statusOptions.map((s) => (
                <ContextMenuRadioItem key={s.value} value={s.value}>
                  {s.label}
                </ContextMenuRadioItem>
              ))}
            </ContextMenuRadioGroup>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSub>
          <ContextMenuSubTrigger>Priority</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuRadioGroup
              value={String(sub.priority)}
              onValueChange={(v) => onUpdate(sub.id, { priority: parseInt(v, 10) })}
            >
              {Object.entries({ 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low', 5: 'Someday' }).map(
                ([value, label]) => (
                  <ContextMenuRadioItem key={value} value={value}>
                    {label}
                  </ContextMenuRadioItem>
                )
              )}
            </ContextMenuRadioGroup>
          </ContextMenuSubContent>
        </ContextMenuSub>
        {onDelete && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={() => onDelete(sub.id)}>
              Delete
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}

export function SortableSubTask(props: {
  sub: Task
  columns?: Project['columns_config']
  statusOptions: Array<{ value: string; label: string }>
  onNavigate?: (id: string) => void
  onUpdate: (id: string, updates: Record<string, unknown>) => void
  onDelete: (id: string) => void
}): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.sub.id
  })
  const style = { transform: CSS.Transform.toString(transform), transition }
  const dragHandle = (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          {...attributes}
          {...listeners}
          className="shrink-0 cursor-grab opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground touch-none"
          onClick={(e) => e.stopPropagation()}
        >
          <GripVertical className="size-3" />
        </span>
      </TooltipTrigger>
      <TooltipContent>Drag to reorder</TooltipContent>
    </Tooltip>
  )
  return (
    <TaskOverviewRow
      {...props}
      rowRef={setNodeRef}
      rowStyle={style}
      isDragging={isDragging}
      dragHandle={dragHandle}
    />
  )
}
