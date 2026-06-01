import { useMemo, useRef, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensors,
  useSensor,
  pointerWithin,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent
} from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import { motion } from 'framer-motion'
import type { Task } from '@slayzone/task/shared'
import type { ColumnConfig } from '@slayzone/projects/shared'
import { isTerminalStatus } from '@slayzone/projects/shared'
import type { Project } from '@slayzone/projects/shared'
import type { Tag } from '@slayzone/tags/shared'
import { groupTasksBy, columnToCreateTaskDraft, type Column } from './kanban'
import type { ViewConfig, CardProperties } from './FilterState'
import { KanbanColumn } from './KanbanColumn'
import { KanbanCard } from './KanbanCard'
import { KanbanPicker } from './KanbanPicker'
import { useKanbanKeyboard } from './useKanbanKeyboard'
import { useKanbanSelection } from './useKanbanSelection'
import { BlockerDialog } from '@slayzone/task/client'
import { useAppearance, useDialogStore } from '@slayzone/settings/client'
import { track } from '@slayzone/telemetry/client'

interface KanbanBoardProps {
  tasks: Task[]
  columns?: ColumnConfig[] | null
  viewConfig: ViewConfig
  isActive?: boolean
  onTaskMove: (taskId: string, newColumnId: string, targetIndex: number) => void
  onTaskBulkMove?: (taskIds: string[], newColumnId: string, targetIndex: number) => void
  onTaskReorder: (taskIds: string[]) => void
  onTaskClick?: (task: Task, e: { metaKey: boolean; shiftKey?: boolean }) => void
  cardProperties?: CardProperties
  taskTags?: Map<string, string[]>
  tags?: Tag[]
  onTaskTagsChange?: (taskId: string, tagIds: string[]) => void
  blockedTaskIds?: Set<string>
  // Context menu props
  allProjects?: Project[]
  onUpdateTask?: (taskId: string, updates: Partial<Task>) => void
  onBulkUpdateTasks?: (taskIds: string[], updates: Partial<Task>) => void
  onClearBlockers?: (taskId: string) => void
  onArchiveTask?: (taskId: string) => void
  onDeleteTask?: (taskId: string) => void
  onBulkDeleteTasks?: (taskIds: string[]) => void
  onArchiveAllTasks?: (taskIds: string[]) => void
  activeAgentTaskIds?: Set<string>
  onShutdownAgent?: (taskId: string) => void
  // Reset selection when this key changes (e.g. project id)
  selectionResetKey?: string | null
}

export function KanbanBoard({
  tasks,
  columns: projectColumns,
  viewConfig,
  isActive = true,
  onTaskMove,
  onTaskBulkMove,
  onTaskReorder,
  onTaskClick,
  cardProperties,
  taskTags,
  tags,
  onTaskTagsChange,
  blockedTaskIds,
  allProjects,
  onUpdateTask,
  onBulkUpdateTasks,
  onClearBlockers,
  onArchiveTask,
  onDeleteTask,
  onBulkDeleteTasks,
  onArchiveAllTasks,
  activeAgentTaskIds,
  onShutdownAgent,
  selectionResetKey
}: KanbanBoardProps): React.JSX.Element {
  const { groupBy, sortBy, showEmptyColumns } = viewConfig
  const disableDrag = groupBy === 'due_date'

  const handleCreateTask = useMemo(() => {
    return (column: Column) =>
      useDialogStore.getState().openCreateTask(columnToCreateTaskDraft(column, groupBy))
  }, [groupBy])
  const { reduceMotion } = useAppearance()
  const [activeId, setActiveId] = useState<string | null>(null)
  const [activeColumnId, setActiveColumnId] = useState<string | null>(null)
  const [overColumnId, setOverColumnId] = useState<string | null>(null)
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5
      }
    }),
    useSensor(KeyboardSensor)
  )

  const allColumns = groupTasksBy(tasks, groupBy, sortBy, projectColumns, {
    blockedTaskIds,
    viewConfig
  })
  const visibleColumns = showEmptyColumns
    ? allColumns
    : allColumns.filter((c) => c.tasks.length > 0)
  const activeTask = activeId ? tasks.find((t) => t.id === activeId) : null

  const selection = useKanbanSelection({ columns: visibleColumns, resetKey: selectionResetKey })

  // Captured at drag start: ids being dragged together (1 = single, >1 = multi)
  const dragSetRef = useRef<string[]>([])
  const [dragSetSize, setDragSetSize] = useState(1)

  // Wrap onTaskClick: shift = toggle selection (no open); meta = bg open (existing); plain = clear + open
  const handleCardClick = (task: Task, e: { metaKey: boolean; shiftKey?: boolean }): void => {
    if (e.shiftKey) {
      selection.toggle(task.id)
      return
    }
    if (!e.metaKey) selection.clear()
    onTaskClick?.(task, e)
  }

  // Right-click intercept: if not in selection, replace with this card; else keep selection
  const handleCardContextMenu = (taskId: string): void => {
    if (!selection.selectedIds.has(taskId)) selection.replace(taskId)
  }

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

  const {
    focusedTaskId,
    setHoveredTaskId,
    pickerState,
    closePickerState,
    blockerDialogTaskId,
    closeBlockerDialog,
    cardRefs
  } = useKanbanKeyboard({
    columns: visibleColumns,
    isActive,
    isDragging: !!activeId,
    onTaskClick: handleCardClick,
    onUpdateTask,
    selection
  })

  function handleDragStart(event: DragStartEvent): void {
    const taskId = event.active.id as string
    setActiveId(taskId)
    // Find which column the dragged task belongs to
    const sourceColumn = visibleColumns.find((c) => c.tasks.some((t) => t.id === taskId))
    setActiveColumnId(sourceColumn?.id ?? null)
    // Capture multi-drag set: if active id is in selection AND >1 selected, drag whole set in grid order.
    if (selection.selectedIds.has(taskId) && selection.selectedIds.size > 1) {
      const ordered: string[] = []
      for (const c of visibleColumns)
        for (const t of c.tasks) if (selection.selectedIds.has(t.id)) ordered.push(t.id)
      dragSetRef.current = ordered
      setDragSetSize(ordered.length)
    } else {
      dragSetRef.current = [taskId]
      setDragSetSize(1)
    }
  }

  function handleDragOver(event: DragOverEvent): void {
    const { over } = event
    if (!over) {
      setOverColumnId(null)
      return
    }

    const overId = over.id as string
    // Check if over a column directly
    let targetColumn = visibleColumns.find((c) => c.id === overId)
    if (!targetColumn) {
      // Over a task - find which column contains it
      targetColumn = visibleColumns.find((c) => c.tasks.some((t) => t.id === overId))
    }
    setOverColumnId(targetColumn?.id ?? null)
  }

  function handleDragEnd(event: DragEndEvent): void {
    const { active, over } = event
    setActiveId(null)
    setActiveColumnId(null)
    setOverColumnId(null)

    if (!over) return

    const taskId = active.id as string
    const overId = over.id as string

    // Find current column containing the dragged task
    const currentColumn = visibleColumns.find((c) => c.tasks.some((t) => t.id === taskId))
    if (!currentColumn) return

    // Determine target column and drop index
    let targetColumn = visibleColumns.find((c) => c.id === overId)
    let targetIndex: number

    if (targetColumn) {
      // Dropped on column itself - add to end
      targetIndex = targetColumn.tasks.length
    } else {
      // Dropped on a task - find that task's column and index
      targetColumn = visibleColumns.find((c) => c.tasks.some((t) => t.id === overId))
      if (!targetColumn) return
      targetIndex = targetColumn.tasks.findIndex((t) => t.id === overId)
    }

    const dragSet = dragSetRef.current.length > 0 ? dragSetRef.current : [taskId]
    const isMulti = dragSet.length > 1

    // Drop into virtual __blocked__ col → set is_blocked flag (don't move/reorder)
    if (targetColumn.id === '__blocked__') {
      if (currentColumn.id === '__blocked__') return
      track('kanban_drag_drop')
      track('task_blocked', {})
      if (isMulti && onBulkUpdateTasks) {
        onBulkUpdateTasks(dragSet, { is_blocked: true } as Partial<Task>)
      } else {
        onUpdateTask?.(taskId, { is_blocked: true } as Partial<Task>)
      }
      return
    }

    if (targetColumn.id.startsWith('__')) return // skip __unknown__, __snoozed__

    const isSameColumn = currentColumn.id === targetColumn.id

    track('kanban_drag_drop')

    if (isSameColumn) {
      if (sortBy === 'priority') {
        // Reorder within same priority group only
        const draggedTask = currentColumn.tasks.find((t) => t.id === taskId)
        const overTask = targetColumn.tasks.find((t) => t.id === overId)
        if (!draggedTask || !overTask) return
        if (draggedTask.priority !== overTask.priority) return

        const samePriorityTasks = currentColumn.tasks.filter(
          (t) => t.priority === draggedTask.priority
        )
        const oldIdx = samePriorityTasks.findIndex((t) => t.id === taskId)
        const newIdx = samePriorityTasks.findIndex((t) => t.id === overId)
        if (oldIdx === newIdx) return

        const reordered = arrayMove(samePriorityTasks, oldIdx, newIdx)
        onTaskReorder(reordered.map((t) => t.id))
        return
      }
      if (sortBy !== 'manual') return // other sorts still block reorder
      // Reorder within same column
      const oldIndex = currentColumn.tasks.findIndex((t) => t.id === taskId)
      if (oldIndex === targetIndex) return

      const reordered = arrayMove(currentColumn.tasks, oldIndex, targetIndex)
      onTaskReorder(reordered.map((t) => t.id))
    } else {
      // Move to different column at specific position
      if (isMulti && onTaskBulkMove) {
        onTaskBulkMove(dragSet, targetColumn.id, targetIndex)
        if (currentColumn.id === '__snoozed__' && onBulkUpdateTasks) {
          onBulkUpdateTasks(dragSet, { snoozed_until: null } as Partial<Task>)
        }
        if (currentColumn.id === '__blocked__') {
          track('task_unblocked')
          onBulkUpdateTasks?.(dragSet, {
            is_blocked: false,
            blocked_comment: null
          } as Partial<Task>)
          for (const id of dragSet) onClearBlockers?.(id)
        }
      } else {
        onTaskMove(taskId, targetColumn.id, targetIndex)
        // Clear snooze when dragging out of snoozed column
        if (currentColumn.id === '__snoozed__' && onUpdateTask) {
          onUpdateTask(taskId, { snoozed_until: null } as Partial<Task>)
        }
        // Clear blocked flag + dependency blockers when dragging out of blocked column
        if (currentColumn.id === '__blocked__') {
          track('task_unblocked')
          onUpdateTask?.(taskId, { is_blocked: false, blocked_comment: null } as Partial<Task>)
          onClearBlockers?.(taskId)
        }
      }
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="relative h-full min-h-0">
        <div className="flex h-full min-h-0 min-w-0 gap-4 overflow-x-auto pr-16 scrollbar-thin">
          {visibleColumns.map((column) => (
            <KanbanColumn
              key={column.id}
              column={column}
              columns={projectColumns}
              activeColumnId={activeColumnId}
              overColumnId={overColumnId}
              onTaskClick={handleCardClick}
              onCardContextMenu={handleCardContextMenu}
              onCreateTask={handleCreateTask}
              disableDrag={disableDrag}
              cardProperties={cardProperties}
              taskTags={taskTags}
              tags={tags}
              onTaskTagsChange={onTaskTagsChange}
              blockedTaskIds={blockedTaskIds}
              subTaskCounts={subTaskCounts}
              focusedTaskId={focusedTaskId}
              selectedTaskIds={selection.selectedIds}
              onCardMouseEnter={setHoveredTaskId}
              cardRefs={cardRefs}
              allProjects={allProjects}
              onUpdateTask={onUpdateTask}
              onBulkUpdateTasks={onBulkUpdateTasks}
              onArchiveTask={onArchiveTask}
              onDeleteTask={onDeleteTask}
              onBulkDeleteTasks={onBulkDeleteTasks}
              onArchiveAllTasks={onArchiveAllTasks}
              activeAgentTaskIds={activeAgentTaskIds}
              onShutdownAgent={onShutdownAgent}
              allTasks={tasks}
            />
          ))}
        </div>
      </div>
      <DragOverlay dropAnimation={reduceMotion ? null : { duration: 33, easing: 'ease-out' }}>
        {activeTask ? (
          <motion.div
            className="relative"
            initial={reduceMotion ? false : { scale: 0.95, opacity: 0.8 }}
            animate={reduceMotion ? {} : { scale: 1.05, opacity: 1 }}
            transition={reduceMotion ? {} : { type: 'spring', stiffness: 1800, damping: 60 }}
          >
            {dragSetSize > 1 && (
              <>
                <div
                  aria-hidden
                  className="absolute inset-0 -z-10 translate-x-2 translate-y-2 rounded-lg bg-surface-3/60 ring-1 ring-border"
                />
                <div
                  aria-hidden
                  className="absolute inset-0 -z-20 translate-x-4 translate-y-4 rounded-lg bg-surface-3/40 ring-1 ring-border"
                />
              </>
            )}
            <KanbanCard task={activeTask} columns={projectColumns} isDragging />
            {dragSetSize > 1 && (
              <span className="absolute -top-2 -right-2 z-10 rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold text-primary-foreground shadow">
                {dragSetSize}
              </span>
            )}
          </motion.div>
        ) : null}
      </DragOverlay>
      {onUpdateTask && (
        <KanbanPicker
          pickerState={pickerState}
          onClose={closePickerState}
          onUpdateTask={onUpdateTask}
          tasks={tasks}
          columns={projectColumns}
          cardRefs={cardRefs}
        />
      )}
      <BlockerDialog
        taskId={blockerDialogTaskId}
        projects={allProjects}
        onClose={closeBlockerDialog}
      />
    </DndContext>
  )
}
