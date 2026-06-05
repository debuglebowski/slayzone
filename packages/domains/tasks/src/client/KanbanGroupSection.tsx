import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import type { Task } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'
import type { ColumnConfig } from '@slayzone/projects/shared'
import type { Tag } from '@slayzone/tags/shared'
import type { Column } from './kanban'
import type { CardProperties } from './FilterState'
import { cn, getColumnStatusStyle, IconButton } from '@slayzone/ui'
import { ChevronDown, Plus } from 'lucide-react'
import { SortableListRow } from './KanbanListRow'

// ── Droppable group wrapper ──

function DroppableGroup({
  columnId,
  children
}: {
  columnId: string
  children: React.ReactNode
}): React.JSX.Element {
  const { setNodeRef } = useDroppable({ id: `group:${columnId}` })
  return <div ref={setNodeRef}>{children}</div>
}

// ── Group section ──

interface GroupSectionProps {
  column: Column
  columns?: ColumnConfig[] | null
  collapsed: boolean
  onToggle: () => void
  showHeader?: boolean
  onCreateTask?: (column: Column) => void
  cp?: CardProperties
  onTaskClick?: (task: Task, e: { metaKey: boolean }) => void
  disableDrag?: boolean
  blockedTaskIds?: Set<string>
  subTaskCounts: Map<string, { done: number; total: number }>
  isDragging?: boolean
  allProjects?: Project[]
  onUpdateTask?: (taskId: string, updates: Partial<Task>) => void
  onArchiveTask?: (taskId: string) => void
  onDeleteTask?: (taskId: string) => void
  tags?: Tag[]
  taskTags?: Map<string, string[]>
  onTaskTagsChange?: (taskId: string, tagIds: string[]) => void
  activeAgentTaskIds?: Set<string>
  onShutdownAgent?: (taskId: string) => void
}

export function GroupSection({
  column,
  columns,
  collapsed,
  onToggle,
  showHeader = true,
  onCreateTask,
  cp,
  onTaskClick,
  disableDrag,
  blockedTaskIds,
  subTaskCounts,
  isDragging,
  allProjects,
  onUpdateTask,
  onArchiveTask,
  onDeleteTask,
  tags,
  taskTags,
  onTaskTagsChange,
  activeAgentTaskIds,
  onShutdownAgent
}: GroupSectionProps): React.JSX.Element {
  return (
    <div>
      {/* Group header */}
      {showHeader && (
        <div className="flex items-center gap-3 px-2.5 py-2 rounded-md bg-muted/50 select-none">
          <button className="flex items-center gap-3 flex-1 min-w-0" onClick={onToggle}>
            <span className="flex items-center justify-center w-[14px] shrink-0">
              <ChevronDown
                className={cn(
                  'size-3.5 text-muted-foreground transition-transform',
                  collapsed && '-rotate-90'
                )}
              />
            </span>
            {(() => {
              const style = getColumnStatusStyle(column.id, columns)
              if (!style) return null
              const Icon = style.icon
              return <Icon className={cn('size-4', style.iconClass)} strokeWidth={2.5} />
            })()}
            <span className="text-base font-semibold text-muted-foreground">{column.title}</span>
            <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              {column.tasks.length}
            </span>
          </button>
          {onCreateTask && (
            <IconButton
              variant="ghost"
              aria-label="Add task"
              className="h-6 w-6 shrink-0"
              onClick={() => onCreateTask(column)}
              title="Add task"
            >
              <Plus className="h-4 w-4" />
            </IconButton>
          )}
        </div>
      )}

      {/* Tasks */}
      {(!showHeader || !collapsed) && (
        <DroppableGroup columnId={column.id}>
          <SortableContext
            items={column.tasks.map((t) => t.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="flex flex-col gap-1">
              {column.tasks.length === 0 && (
                <div
                  className={cn(
                    'px-2.5 py-3 text-xs text-center rounded-md transition-colors',
                    isDragging
                      ? 'text-muted-foreground/50 bg-muted/30 border border-dashed border-muted-foreground/20'
                      : 'text-transparent'
                  )}
                >
                  Drop here
                </div>
              )}
              {column.tasks.map((task) => (
                <SortableListRow
                  key={task.id}
                  task={task}
                  columns={columns}
                  cp={cp}
                  onClick={onTaskClick}
                  disableDrag={disableDrag}
                  isBlocked={blockedTaskIds?.has(task.id)}
                  subTaskCount={subTaskCounts.get(task.id)}
                  allProjects={allProjects}
                  onUpdateTask={onUpdateTask}
                  onArchiveTask={onArchiveTask}
                  onDeleteTask={onDeleteTask}
                  tags={tags}
                  taskTagIds={taskTags?.get(task.id)}
                  onTaskTagsChange={onTaskTagsChange}
                  activeAgentTaskIds={activeAgentTaskIds}
                  onShutdownAgent={onShutdownAgent}
                />
              ))}
            </div>
          </SortableContext>
        </DroppableGroup>
      )}
    </div>
  )
}
