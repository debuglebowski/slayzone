import { useCallback } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { MoreHorizontal, Plus, ShieldAlert, AlarmClockOff } from 'lucide-react'
import type { Task } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'
import type { ColumnConfig } from '@slayzone/projects/shared'
import { getColumnById, isCompletedCategory } from '@slayzone/projects/shared'
import type { Tag } from '@slayzone/tags/shared'
import type { Column } from './kanban'
import type { CardProperties } from './FilterState'
import { KanbanCard } from './KanbanCard'
import { TaskContextMenu } from './TaskContextMenu'
import { BulkTaskContextMenu } from './BulkTaskContextMenu'
import { IconButton } from '@slayzone/ui'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@slayzone/ui'
import { cn, getColumnStatusStyle, isPrimaryModifier } from '@slayzone/ui'

interface SortableKanbanCardProps {
  task: Task
  columns?: ColumnConfig[] | null
  onTaskClick?: (task: Task, e: { metaKey: boolean; shiftKey?: boolean }) => void
  onContextMenu?: (taskId: string) => void
  disableDrag?: boolean
  cardProperties?: CardProperties
  isBlocked?: boolean
  isFocused?: boolean
  isSelected?: boolean
  isMultiDragGhost?: boolean
  selectedTaskIds?: Set<string>
  allTasks?: Task[]
  taskTagsMap?: Map<string, string[]>
  onMouseEnter?: () => void
  cardRefs?: React.MutableRefObject<Map<string, HTMLDivElement>>
  subTaskCount?: { done: number; total: number }
  taskTagIds?: string[]
  tags?: Tag[]
  onTaskTagsChange?: (taskId: string, tagIds: string[]) => void
  // Context menu props
  allProjects?: Project[]
  onUpdateTask?: (taskId: string, updates: Partial<Task>) => void
  onBulkUpdateTasks?: (taskIds: string[], updates: Partial<Task>) => void
  onArchiveTask?: (taskId: string) => void
  onArchiveAllTasks?: (taskIds: string[]) => void
  onDeleteTask?: (taskId: string) => void
  onBulkDeleteTasks?: (taskIds: string[]) => void
  activeAgentTaskIds?: Set<string>
  onShutdownAgent?: (taskId: string) => void
}

function SortableKanbanCard({
  task,
  columns,
  onTaskClick,
  onContextMenu,
  disableDrag,
  cardProperties,
  isBlocked,
  isFocused,
  isSelected,
  isMultiDragGhost,
  selectedTaskIds,
  allTasks,
  taskTagsMap,
  onMouseEnter,
  cardRefs,
  subTaskCount,
  taskTagIds,
  tags,
  onTaskTagsChange,
  allProjects,
  onUpdateTask,
  onBulkUpdateTasks,
  onArchiveTask,
  onArchiveAllTasks,
  onDeleteTask,
  onBulkDeleteTasks,
  activeAgentTaskIds,
  onShutdownAgent
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
    <div
      ref={combinedRef}
      style={style}
      {...dragProps}
      onMouseEnter={onMouseEnter}
      onContextMenuCapture={() => onContextMenu?.(task.id)}
    >
      <KanbanCard
        task={task}
        columns={columns}
        isDragging={isDragging}
        isFocused={isFocused}
        isSelected={isSelected}
        isMultiDragGhost={isMultiDragGhost}
        onClick={(e) => onTaskClick?.(task, { metaKey: isPrimaryModifier(e), shiftKey: e.shiftKey })}
        isBlocked={isBlocked}
        subTaskCount={subTaskCount}
        cardProperties={cardProperties}
        taskTagIds={taskTagIds}
        tags={tags}
        onUpdateTask={onUpdateTask}
        onTaskTagsChange={onTaskTagsChange}
      />
    </div>
  )

  // Wrap with bulk context menu when current task is part of a multi-selection
  const isInBulk = !!(isSelected && selectedTaskIds && selectedTaskIds.size > 1)
  if (isInBulk && allProjects && onBulkUpdateTasks) {
    const selectedIdArr = [...selectedTaskIds!]
    const selectedTasks = (allTasks ?? []).filter((t) => selectedTaskIds!.has(t.id))
    return (
      <BulkTaskContextMenu
        taskIds={selectedIdArr}
        tasks={selectedTasks}
        projects={allProjects}
        columns={columns}
        tags={tags}
        taskTagsMap={taskTagsMap}
        onBulkUpdate={onBulkUpdateTasks}
        onBulkArchive={onArchiveAllTasks}
        onBulkDelete={onBulkDeleteTasks}
        onTaskTagsChange={onTaskTagsChange}
      >
        {card}
      </BulkTaskContextMenu>
    )
  }

  // Wrap with single-task context menu if handlers provided
  if (allProjects && onUpdateTask && onArchiveTask && onDeleteTask) {
    return (
      <TaskContextMenu
        task={task}
        projects={allProjects}
        columns={columns}
        tags={tags}
        taskTagIds={taskTagIds}
        isBlocked={isBlocked}
        onUpdateTask={onUpdateTask}
        onArchiveTask={onArchiveTask}
        onDeleteTask={onDeleteTask}
        onTaskTagsChange={onTaskTagsChange}
        onShutdownAgent={
          activeAgentTaskIds?.has(task.id) && onShutdownAgent
            ? () => onShutdownAgent(task.id)
            : undefined
        }
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
  onTaskClick?: (task: Task, e: { metaKey: boolean; shiftKey?: boolean }) => void
  onCardContextMenu?: (taskId: string) => void
  onCreateTask?: (column: Column) => void
  disableDrag?: boolean
  cardProperties?: CardProperties
  taskTags?: Map<string, string[]>
  tags?: Tag[]
  onTaskTagsChange?: (taskId: string, tagIds: string[]) => void
  blockedTaskIds?: Set<string>
  subTaskCounts?: Map<string, { done: number; total: number }>
  focusedTaskId?: string | null
  selectedTaskIds?: Set<string>
  allTasks?: Task[]
  onCardMouseEnter?: (taskId: string) => void
  cardRefs?: React.MutableRefObject<Map<string, HTMLDivElement>>
  // Context menu props
  allProjects?: Project[]
  onUpdateTask?: (taskId: string, updates: Partial<Task>) => void
  onBulkUpdateTasks?: (taskIds: string[], updates: Partial<Task>) => void
  onArchiveTask?: (taskId: string) => void
  onDeleteTask?: (taskId: string) => void
  onBulkDeleteTasks?: (taskIds: string[]) => void
  onArchiveAllTasks?: (taskIds: string[]) => void
  activeAgentTaskIds?: Set<string>
  onShutdownAgent?: (taskId: string) => void
}

export function KanbanColumn({
  column,
  columns,
  activeColumnId,
  overColumnId,
  onTaskClick,
  onCardContextMenu,
  onCreateTask,
  disableDrag,
  cardProperties,
  taskTags,
  tags,
  onTaskTagsChange,
  blockedTaskIds,
  subTaskCounts,
  focusedTaskId,
  selectedTaskIds,
  allTasks,
  onCardMouseEnter,
  cardRefs,
  allProjects,
  onUpdateTask,
  onBulkUpdateTasks,
  onArchiveTask,
  onDeleteTask,
  onBulkDeleteTasks,
  onArchiveAllTasks,
  activeAgentTaskIds,
  onShutdownAgent
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
    <div data-testid="kanban-column" className="flex h-full min-h-0 w-72 shrink-0 flex-col">
      <div className="mb-2 flex items-center justify-between px-2 select-none">
        <div className="flex items-center gap-2">
          {(() => {
            if (column.id === '__blocked__')
              return <ShieldAlert className="size-4 text-red-500" strokeWidth={2.5} />
            if (column.id === '__snoozed__')
              return <AlarmClockOff className="size-4 text-orange-500" strokeWidth={2.5} />
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
          'flex-1 min-h-0 overflow-y-auto rounded-lg bg-surface-2 p-2 scrollbar-thin',
          showDropHighlight && 'bg-surface-3 ring-2 ring-primary/20'
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
                onContextMenu={onCardContextMenu}
                disableDrag={disableDrag}
                cardProperties={cardProperties}
                taskTagIds={taskTags?.get(task.id)}
                tags={tags}
                onTaskTagsChange={onTaskTagsChange}
                isBlocked={blockedTaskIds?.has(task.id)}
                isFocused={focusedTaskId === task.id}
                isSelected={selectedTaskIds?.has(task.id)}
                isMultiDragGhost={
                  !!activeColumnId &&
                  (selectedTaskIds?.has(task.id) ?? false) &&
                  (selectedTaskIds?.size ?? 0) > 1
                }
                selectedTaskIds={selectedTaskIds}
                allTasks={allTasks}
                taskTagsMap={taskTags}
                onMouseEnter={() => onCardMouseEnter?.(task.id)}
                cardRefs={cardRefs}
                subTaskCount={subTaskCounts?.get(task.id)}
                allProjects={allProjects}
                onUpdateTask={onUpdateTask}
                onBulkUpdateTasks={onBulkUpdateTasks}
                onArchiveTask={onArchiveTask}
                onArchiveAllTasks={onArchiveAllTasks}
                onDeleteTask={onDeleteTask}
                onBulkDeleteTasks={onBulkDeleteTasks}
                activeAgentTaskIds={activeAgentTaskIds}
                onShutdownAgent={onShutdownAgent}
              />
            ))}
          </div>
        </SortableContext>
      </div>
    </div>
  )
}
