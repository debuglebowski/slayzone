import { useCallback } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { MoreHorizontal, Plus } from 'lucide-react'
import type { Task } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'
import type { ColumnConfig } from '@slayzone/projects/shared'
import { getColumnById, isCompletedCategory } from '@slayzone/projects/shared'
import type { Tag } from '@slayzone/tags/shared'
import type { Column } from './kanban'
import type { CardProperties } from './FilterState'
import { KanbanCard } from './KanbanCard'
import { TaskContextMenu } from './TaskContextMenu'
import { IconButton } from '@slayzone/ui'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@slayzone/ui'
import { cn, getColumnStatusStyle } from '@slayzone/ui'

interface SortableKanbanCardProps {
  task: Task
  columns?: ColumnConfig[] | null
  onTaskClick?: (task: Task, e: { metaKey: boolean }) => void
  project?: Project
  showProject?: boolean
  disableDrag?: boolean
  cardProperties?: CardProperties
  isBlocked?: boolean
  isFocused?: boolean
  onMouseEnter?: () => void
  cardRefs?: React.MutableRefObject<Map<string, HTMLDivElement>>
  subTaskCount?: { done: number; total: number }
  taskTagIds?: string[]
  tags?: Tag[]
  // Context menu props
  allProjects?: Project[]
  onUpdateTask?: (taskId: string, updates: Partial<Task>) => void
  onArchiveTask?: (taskId: string) => void
  onDeleteTask?: (taskId: string) => void
}

function SortableKanbanCard({
  task,
  columns,
  onTaskClick,
  project,
  showProject,
  disableDrag,
  cardProperties,
  isBlocked,
  isFocused,
  onMouseEnter,
  cardRefs,
  subTaskCount,
  taskTagIds,
  tags,
  allProjects,
  onUpdateTask,
  onArchiveTask,
  onDeleteTask
}: SortableKanbanCardProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    disabled: disableDrag
  })

  const combinedRef = useCallback(
    (el: HTMLDivElement | null) => {
      setNodeRef(el)
      if (cardRefs) {
        if (el) cardRefs.current.set(task.id, el)
        else cardRefs.current.delete(task.id)
      }
    },
    [setNodeRef, task.id, cardRefs]
  )

  const style = {
    transform: CSS.Transform.toString(transform),
    transition
  }

  // When drag disabled, don't pass listeners/attributes
  const dragProps = disableDrag ? {} : { ...attributes, ...listeners }

  const card = (
    <div ref={combinedRef} style={style} {...dragProps} onMouseEnter={onMouseEnter}>
      <KanbanCard
        task={task}
        columns={columns}
        isDragging={isDragging}
        isFocused={isFocused}
        onClick={(e) => onTaskClick?.(task, e)}
        project={project}
        showProject={showProject}
        isBlocked={isBlocked}
        subTaskCount={subTaskCount}
        cardProperties={cardProperties}
        taskTagIds={taskTagIds}
        tags={tags}
      />
    </div>
  )

  // Wrap with context menu if handlers provided
  if (allProjects && onUpdateTask && onArchiveTask && onDeleteTask) {
    return (
      <TaskContextMenu
        task={task}
        projects={allProjects}
        columns={columns}
        onUpdateTask={onUpdateTask}
        onArchiveTask={onArchiveTask}
        onDeleteTask={onDeleteTask}
      >
        {card}
      </TaskContextMenu>
    )
  }

  return card
}

interface KanbanColumnProps {
  column: Column
  columns?: ColumnConfig[] | null
  activeColumnId?: string | null
  overColumnId?: string | null
  onTaskClick?: (task: Task, e: { metaKey: boolean }) => void
  onCreateTask?: (column: Column) => void
  projectsMap?: Map<string, Project>
  showProjectDot?: boolean
  disableDrag?: boolean
  cardProperties?: CardProperties
  taskTags?: Map<string, string[]>
  tags?: Tag[]
  blockedTaskIds?: Set<string>
  subTaskCounts?: Map<string, { done: number; total: number }>
  focusedTaskId?: string | null
  onCardMouseEnter?: (taskId: string) => void
  cardRefs?: React.MutableRefObject<Map<string, HTMLDivElement>>
  // Context menu props
  allProjects?: Project[]
  onUpdateTask?: (taskId: string, updates: Partial<Task>) => void
  onArchiveTask?: (taskId: string) => void
  onDeleteTask?: (taskId: string) => void
  onArchiveAllTasks?: (taskIds: string[]) => void
}

export function KanbanColumn({
  column,
  columns,
  activeColumnId,
  overColumnId,
  onTaskClick,
  onCreateTask,
  projectsMap,
  showProjectDot,
  disableDrag,
  cardProperties,
  taskTags,
  tags,
  blockedTaskIds,
  subTaskCounts,
  focusedTaskId,
  onCardMouseEnter,
  cardRefs,
  allProjects,
  onUpdateTask,
  onArchiveTask,
  onDeleteTask,
  onArchiveAllTasks
}: KanbanColumnProps): React.JSX.Element {
  const columnConfig = getColumnById(column.id, columns)
  const isCompletedColumn = columnConfig ? isCompletedCategory(columnConfig.category) : false
  const { setNodeRef } = useDroppable({
    id: column.id
  })

  // Highlight when dragging over this column from a different column
  const showDropHighlight =
    overColumnId === column.id && activeColumnId !== null && activeColumnId !== column.id

  return (
    <div className="flex w-72 shrink-0 flex-col h-full">
      <div className="mb-2 flex items-center justify-between px-2 select-none">
        <div className="flex items-center gap-2">
          {(() => {
            const style = getColumnStatusStyle(column.id, columns)
            if (!style) return null
            const Icon = style.icon
            return <Icon className={cn('size-4', style.iconClass)} strokeWidth={2.5} />
          })()}
          <h3 className="text-sm font-semibold text-muted-foreground">{column.title}</h3>
          <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
            {column.tasks.length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {isCompletedColumn && onArchiveAllTasks && column.tasks.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton variant="ghost" aria-label="Column options" className="h-6 w-6">
                  <MoreHorizontal className="h-4 w-4" />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onArchiveAllTasks(column.tasks.map((t) => t.id))}>
                  Archive all tasks
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {onCreateTask && (
            <IconButton
              variant="ghost"
              aria-label="Add task"
              className="h-6 w-6"
              onClick={() => onCreateTask(column)}
              title="Add task"
            >
              <Plus className="h-4 w-4" />
            </IconButton>
          )}
        </div>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          'flex-1 h-full rounded-lg bg-muted/30 p-2 min-h-[200px] overflow-y-auto scrollbar-hide',
          showDropHighlight && 'bg-muted/50 ring-2 ring-primary/20'
        )}
      >
        <SortableContext
          items={column.tasks.map((t) => t.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="flex flex-col gap-2">
            {column.tasks.map((task) => (
              <SortableKanbanCard
                key={task.id}
                task={task}
                columns={columns}
                onTaskClick={onTaskClick}
                project={showProjectDot ? projectsMap?.get(task.project_id) : undefined}
                showProject={showProjectDot}
                disableDrag={disableDrag}
                cardProperties={cardProperties}
                taskTagIds={taskTags?.get(task.id)}
                tags={tags}
                isBlocked={blockedTaskIds?.has(task.id)}
                isFocused={focusedTaskId === task.id}
                onMouseEnter={() => onCardMouseEnter?.(task.id)}
                cardRefs={cardRefs}
                subTaskCount={subTaskCounts?.get(task.id)}
                allProjects={allProjects}
                onUpdateTask={onUpdateTask}
                onArchiveTask={onArchiveTask}
                onDeleteTask={onDeleteTask}
              />
            ))}
          </div>
        </SortableContext>
      </div>
    </div>
  )
}
