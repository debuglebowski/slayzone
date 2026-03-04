import { useMemo, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensors,
  useSensor,
  closestCenter,
  type DragStartEvent,
  type DragEndEvent
} from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { Task } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'
import type { ColumnConfig } from '@slayzone/projects/shared'
import { isTerminalStatus } from '@slayzone/projects/shared'
import type { TerminalState } from '@slayzone/terminal/shared'
import { groupTasksBy, PRIORITY_LABELS, todayISO, type Column } from './kanban'
import type { ViewConfig, CardProperties } from './FilterState'
import { TaskContextMenu } from './TaskContextMenu'
import { cn, getTerminalStateStyle, Tooltip, TooltipContent, TooltipTrigger } from '@slayzone/ui'
import { IconButton } from '@slayzone/ui'
import { ChevronDown, Plus, AlertCircle, Check, GitMerge, Link2 } from 'lucide-react'
import { usePty, useActiveTaskIds } from '@slayzone/terminal'
import { useEffect } from 'react'

// ── Types ──

interface KanbanListViewProps {
  tasks: Task[]
  columns?: ColumnConfig[] | null
  viewConfig: ViewConfig
  onTaskMove: (taskId: string, newColumnId: string, targetIndex: number) => void
  onTaskReorder: (taskIds: string[]) => void
  onTaskClick?: (task: Task, e: { metaKey: boolean }) => void
  onCreateTask?: (column: Column) => void
  projectsMap?: Map<string, Project>
  showProjectDot?: boolean
  cardProperties?: CardProperties
  blockedTaskIds?: Set<string>
  allProjects?: Project[]
  onUpdateTask?: (taskId: string, updates: Partial<Task>) => void
  onArchiveTask?: (taskId: string) => void
  onDeleteTask?: (taskId: string, options?: { deleteFeatureDir?: boolean }) => void
}

// ── Priority bar (same as KanbanCard) ──

const PRIORITY_BAR_COLORS: Record<number, string> = {
  1: 'bg-red-500',
  2: 'bg-orange-500',
  3: 'bg-yellow-500',
  4: 'bg-blue-400',
  5: 'bg-muted-foreground/30'
}

function PriorityBar({ priority }: { priority: number }): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex items-end justify-center gap-[1.5px] shrink-0 w-[14px]">
          {[3, 5, 7, 9].map((h, i) => (
            <span
              key={i}
              className={cn(
                'w-[2px] rounded-[0.5px]',
                i < 5 - priority ? PRIORITY_BAR_COLORS[priority] : 'bg-muted-foreground/20'
              )}
              style={{ height: h }}
            />
          ))}
        </span>
      </TooltipTrigger>
      <TooltipContent>{PRIORITY_LABELS[priority]}</TooltipContent>
    </Tooltip>
  )
}

// ── Terminal state dot ──

function TerminalDot({ taskId }: { taskId: string }): React.JSX.Element | null {
  const { getState, subscribeState } = usePty()
  const sessionId = `${taskId}:${taskId}`
  const [terminalState, setTerminalState] = useState<TerminalState>(() => getState(sessionId))

  useEffect(() => {
    setTerminalState(getState(sessionId))
    return subscribeState(sessionId, (s) => setTerminalState(s))
  }, [sessionId, getState, subscribeState])

  if (terminalState === 'starting') return null
  const style = getTerminalStateStyle(terminalState)
  if (!style) return null

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('h-2 w-2 rounded-full shrink-0', style.color)} />
      </TooltipTrigger>
      <TooltipContent>{style.label}</TooltipContent>
    </Tooltip>
  )
}

// ── Sortable list row ──

interface ListRowProps {
  task: Task
  columns?: ColumnConfig[] | null
  cp?: CardProperties
  onClick?: (task: Task, e: { metaKey: boolean }) => void
  project?: Project
  showProject?: boolean
  isBlocked?: boolean
  subTaskCount?: { done: number; total: number }
  disableDrag?: boolean
  allProjects?: Project[]
  onUpdateTask?: (taskId: string, updates: Partial<Task>) => void
  onArchiveTask?: (taskId: string) => void
  onDeleteTask?: (taskId: string, options?: { deleteFeatureDir?: boolean }) => void
}

function SortableListRow(props: ListRowProps): React.JSX.Element {
  const { task, disableDrag } = props
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    disabled: disableDrag
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition
  }

  const dragProps = disableDrag ? {} : { ...attributes, ...listeners }

  const row = <ListRowContent {...props} isDragging={isDragging} />

  const wrapped = props.allProjects && props.onUpdateTask && props.onArchiveTask && props.onDeleteTask ? (
    <TaskContextMenu
      task={task}
      projects={props.allProjects}
      columns={props.columns}
      onUpdateTask={props.onUpdateTask}
      onArchiveTask={props.onArchiveTask}
      onDeleteTask={props.onDeleteTask}
    >
      <div ref={setNodeRef} style={style} {...dragProps}>
        {row}
      </div>
    </TaskContextMenu>
  ) : (
    <div ref={setNodeRef} style={style} {...dragProps}>
      {row}
    </div>
  )

  return wrapped
}

function ListRowContent({
  task,
  columns,
  cp,
  onClick,
  project,
  showProject,
  isBlocked,
  subTaskCount,
  isDragging
}: ListRowProps & { isDragging?: boolean }): React.JSX.Element {
  const today = todayISO()
  const isOverdue = task.due_date && task.due_date < today && !isTerminalStatus(task.status, columns)

  return (
    <div
      className={cn(
        'flex items-center gap-3 px-2.5 py-2.5 rounded-md cursor-pointer select-none transition-colors duration-[400ms] hover:duration-[100ms] hover:bg-muted/30',
        isDragging && 'opacity-50',
        isTerminalStatus(task.status, columns) && 'opacity-60'
      )}
      onClick={(e) => onClick?.(task, e)}
    >
      {/* Project dot */}
      {showProject && project && (
        <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ backgroundColor: project.color }} title={project.name} />
      )}
      {showProject && !project && (
        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30 shrink-0" />
      )}

      {/* Priority bar */}
      {(cp?.priority ?? true) && <PriorityBar priority={task.priority} />}

      {/* Title */}
      <span className={cn('flex-1 text-sm font-medium truncate', isTerminalStatus(task.status, columns) && 'line-through text-muted-foreground')}>
        {task.title}
      </span>

      {/* Right-side metadata */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Terminal state */}
        {(cp?.terminal ?? true) && <TerminalDot taskId={task.id} />}

        {/* Merge */}
        {(cp?.merge ?? true) && task.merge_state && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="shrink-0"><GitMerge className="h-3 w-3 text-purple-400" /></span>
            </TooltipTrigger>
            <TooltipContent>Merging</TooltipContent>
          </Tooltip>
        )}

        {/* Linear */}
        {(cp?.linear ?? true) && task.linear_url && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="shrink-0 h-2 w-2 rounded-full bg-indigo-500" />
            </TooltipTrigger>
            <TooltipContent>Linked to Linear</TooltipContent>
          </Tooltip>
        )}

        {/* Blocked */}
        {(cp?.blocked ?? true) && isBlocked && (
          <span className="flex items-center text-amber-500 shrink-0" title="Blocked">
            <Link2 className="h-3 w-3" />
          </span>
        )}

        {/* Due date */}
        {(cp?.dueDate ?? true) && isOverdue && (
          <span className="flex items-center gap-1 text-destructive shrink-0 text-[10px] font-medium">
            <AlertCircle className="h-3 w-3" />
            {task.due_date}
          </span>
        )}
        {(cp?.dueDate ?? true) && task.due_date && !isOverdue && (
          <span className="text-muted-foreground text-[10px] shrink-0">{task.due_date}</span>
        )}

        {/* Sub-tasks */}
        {(cp?.subtasks ?? true) && subTaskCount && subTaskCount.total > 0 && (
          <span className={cn(
            'flex items-center gap-0.5 text-[10px] shrink-0',
            subTaskCount.done === subTaskCount.total ? 'text-green-500' : 'text-muted-foreground'
          )}>
            <Check className="size-3" />
            {subTaskCount.done}/{subTaskCount.total}
          </span>
        )}
      </div>
    </div>
  )
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
  projectsMap?: Map<string, Project>
  showProjectDot?: boolean
  disableDrag?: boolean
  blockedTaskIds?: Set<string>
  subTaskCounts: Map<string, { done: number; total: number }>
  allProjects?: Project[]
  onUpdateTask?: (taskId: string, updates: Partial<Task>) => void
  onArchiveTask?: (taskId: string) => void
  onDeleteTask?: (taskId: string, options?: { deleteFeatureDir?: boolean }) => void
}

function GroupSection({
  column,
  columns,
  collapsed,
  onToggle,
  showHeader = true,
  onCreateTask,
  cp,
  onTaskClick,
  projectsMap,
  showProjectDot,
  disableDrag,
  blockedTaskIds,
  subTaskCounts,
  allProjects,
  onUpdateTask,
  onArchiveTask,
  onDeleteTask
}: GroupSectionProps): React.JSX.Element {
  return (
    <div>
      {/* Group header */}
      {showHeader && (
        <div className="flex items-center gap-3 px-2.5 py-2 rounded-md bg-muted/50 select-none">
          <button className="flex items-center gap-3 flex-1 min-w-0" onClick={onToggle}>
            <span className="flex items-center justify-center w-[14px] shrink-0">
              <ChevronDown className={cn('size-3.5 text-muted-foreground transition-transform', collapsed && '-rotate-90')} />
            </span>
            <span className="text-base font-semibold text-muted-foreground">{column.title}</span>
            <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">{column.tasks.length}</span>
          </button>
          {onCreateTask && (
            <IconButton variant="ghost" aria-label="Add task" className="h-6 w-6 shrink-0" onClick={() => onCreateTask(column)} title="Add task">
              <Plus className="h-4 w-4" />
            </IconButton>
          )}
        </div>
      )}

      {/* Tasks */}
      {(!showHeader || !collapsed) && (
        <SortableContext items={column.tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-1">
            {column.tasks.map((task) => (
              <SortableListRow
                key={task.id}
                task={task}
                columns={columns}
                cp={cp}
                onClick={onTaskClick}
                project={showProjectDot ? projectsMap?.get(task.project_id) : undefined}
                showProject={showProjectDot}
                disableDrag={disableDrag}
                isBlocked={blockedTaskIds?.has(task.id)}
                subTaskCount={subTaskCounts.get(task.id)}
                allProjects={allProjects}
                onUpdateTask={onUpdateTask}
                onArchiveTask={onArchiveTask}
                onDeleteTask={onDeleteTask}
              />
            ))}
          </div>
        </SortableContext>
      )}
    </div>
  )
}

// ── Main component ──

export function KanbanListView({
  tasks,
  columns: projectColumns,
  viewConfig,
  onTaskMove,
  onTaskReorder,
  onTaskClick,
  onCreateTask,
  projectsMap,
  showProjectDot,
  cardProperties,
  blockedTaskIds,
  allProjects,
  onUpdateTask,
  onArchiveTask,
  onDeleteTask
}: KanbanListViewProps): React.JSX.Element {
  const { groupBy, sortBy, showEmptyColumns } = viewConfig
  const disableDrag = groupBy === 'due_date'
  const [activeId, setActiveId] = useState<string | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor)
  )

  const shouldTrackActive = groupBy === 'active'
  const activeTaskIds = useActiveTaskIds()

  const allColumns = useMemo(() => {
    const base = groupTasksBy(tasks, groupBy, sortBy, projectColumns)
    if (shouldTrackActive && base.length === 1) {
      const all = base[0].tasks
      const active: Task[] = []
      const rest: Task[] = []
      for (const t of all) {
        if (activeTaskIds.has(t.id)) active.push(t)
        else rest.push(t)
      }
      const cols: Column[] = []
      if (active.length > 0 || showEmptyColumns) cols.push({ id: 'active', title: 'Active', tasks: active })
      if (rest.length > 0 || showEmptyColumns) cols.push({ id: 'inactive', title: 'Inactive', tasks: rest })
      return cols
    }
    return base
  }, [tasks, projectColumns, groupBy, sortBy, shouldTrackActive, showEmptyColumns, activeTaskIds])

  const visibleColumns = showEmptyColumns ? allColumns : allColumns.filter((c) => c.tasks.length > 0)
  const activeTask = activeId ? tasks.find((t) => t.id === activeId) : null

  const subTaskCounts = useMemo(() => {
    const counts = new Map<string, { done: number; total: number }>()
    for (const t of tasks) {
      if (!t.parent_id) continue
      const entry = counts.get(t.parent_id) ?? { done: 0, total: 0 }
      entry.total++
      if (isTerminalStatus(t.status, projectColumns)) entry.done++
      counts.set(t.parent_id, entry)
    }
    return counts
  }, [tasks, projectColumns])

  function toggleGroup(id: string): void {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function handleDragStart(event: DragStartEvent): void {
    setActiveId(event.active.id as string)
  }

  function handleDragEnd(event: DragEndEvent): void {
    const { active, over } = event
    setActiveId(null)
    if (!over) return

    const taskId = active.id as string
    const overId = over.id as string
    if (taskId === overId) return

    // Find source and target columns
    const sourceColumn = visibleColumns.find((c) => c.tasks.some((t) => t.id === taskId))
    const targetColumn = visibleColumns.find((c) => c.tasks.some((t) => t.id === overId))
    if (!sourceColumn || !targetColumn) return
    if (targetColumn.id === '__unknown__') return

    if (sourceColumn.id === targetColumn.id) {
      // Reorder within same group
      if (sortBy !== 'manual' && sortBy !== 'priority') return
      const oldIndex = sourceColumn.tasks.findIndex((t) => t.id === taskId)
      const newIndex = sourceColumn.tasks.findIndex((t) => t.id === overId)
      if (sortBy === 'priority') {
        const draggedTask = sourceColumn.tasks[oldIndex]
        const overTask = sourceColumn.tasks[newIndex]
        if (draggedTask.priority !== overTask.priority) return
        const samePriority = sourceColumn.tasks.filter((t) => t.priority === draggedTask.priority)
        const oldIdx = samePriority.findIndex((t) => t.id === taskId)
        const newIdx = samePriority.findIndex((t) => t.id === overId)
        const reordered = arrayMove(samePriority, oldIdx, newIdx)
        onTaskReorder(reordered.map((t) => t.id))
        return
      }
      const reordered = arrayMove(sourceColumn.tasks, oldIndex, newIndex)
      onTaskReorder(reordered.map((t) => t.id))
    } else {
      // Move to different group
      const targetIndex = targetColumn.tasks.findIndex((t) => t.id === overId)
      onTaskMove(taskId, targetColumn.id, targetIndex)
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="h-full overflow-y-auto space-y-6 pr-2">
        {visibleColumns.map((column) => (
          <GroupSection
            key={column.id}
            column={column}
            columns={projectColumns}
            collapsed={collapsedGroups.has(column.id)}
            onToggle={() => toggleGroup(column.id)}
            showHeader={groupBy !== 'none'}
            onCreateTask={onCreateTask}
            cp={cardProperties}
            onTaskClick={onTaskClick}
            projectsMap={projectsMap}
            showProjectDot={showProjectDot}
            disableDrag={disableDrag}
            blockedTaskIds={blockedTaskIds}
            subTaskCounts={subTaskCounts}
            allProjects={allProjects}
            onUpdateTask={onUpdateTask}
            onArchiveTask={onArchiveTask}
            onDeleteTask={onDeleteTask}
          />
        ))}
      </div>
      <DragOverlay>
        {activeTask ? (
          <div className="rounded-md bg-background border px-2.5 py-1.5 shadow-lg text-xs font-medium opacity-90">
            {activeTask.title}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}
