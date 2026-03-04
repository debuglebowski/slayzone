import { useMemo, useState } from 'react'
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
import { groupTasksBy, type Column } from './kanban'
import type { ViewConfig, CardProperties } from './FilterState'
import { KanbanColumn } from './KanbanColumn'
import { KanbanCard } from './KanbanCard'
import { KanbanPicker } from './KanbanPicker'
import { useKanbanKeyboard } from './useKanbanKeyboard'
import { useAppearance } from '@slayzone/settings/client'

interface KanbanBoardProps {
  tasks: Task[]
  columns?: ColumnConfig[] | null
  viewConfig: ViewConfig
  isActive?: boolean
  onTaskMove: (taskId: string, newColumnId: string, targetIndex: number) => void
  onTaskReorder: (taskIds: string[]) => void
  onTaskClick?: (task: Task, e: { metaKey: boolean }) => void
  onCreateTask?: (column: Column) => void
  projectsMap?: Map<string, Project>
  showProjectDot?: boolean
  cardProperties?: CardProperties
  taskTags?: Map<string, string[]>
  tags?: Tag[]
  blockedTaskIds?: Set<string>
  // Context menu props
  allProjects?: Project[]
  onUpdateTask?: (taskId: string, updates: Partial<Task>) => void
  onArchiveTask?: (taskId: string) => void
  onDeleteTask?: (taskId: string, options?: { deleteFeatureDir?: boolean }) => void
  onArchiveAllTasks?: (taskIds: string[]) => void
}

export function KanbanBoard({
  tasks,
  columns: projectColumns,
  viewConfig,
  isActive = true,
  onTaskMove,
  onTaskReorder,
  onTaskClick,
  onCreateTask,
  projectsMap,
  showProjectDot,
  cardProperties,
  taskTags,
  tags,
  blockedTaskIds,
  allProjects,
  onUpdateTask,
  onArchiveTask,
  onDeleteTask,
  onArchiveAllTasks
}: KanbanBoardProps): React.JSX.Element {
  const { groupBy, sortBy, showEmptyColumns } = viewConfig
  const disableDrag = groupBy === 'due_date'
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

  const allColumns = groupTasksBy(tasks, groupBy, sortBy, projectColumns)
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

  const {
    focusedTaskId,
    setHoveredTaskId,
    pickerState,
    closePickerState,
    cardRefs
  } = useKanbanKeyboard({
    columns: visibleColumns,
    isActive,
    isDragging: !!activeId,
    onTaskClick,
    onUpdateTask
  })

  function handleDragStart(event: DragStartEvent): void {
    const taskId = event.active.id as string
    setActiveId(taskId)
    // Find which column the dragged task belongs to
    const sourceColumn = visibleColumns.find((c) => c.tasks.some((t) => t.id === taskId))
    setActiveColumnId(sourceColumn?.id ?? null)
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

    if (targetColumn.id === '__unknown__') return

    const isSameColumn = currentColumn.id === targetColumn.id

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
      onTaskMove(taskId, targetColumn.id, targetIndex)
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
      <div className="flex gap-4 overflow-x-auto pr-16 h-full [&::-webkit-scrollbar]:hidden">
        {visibleColumns.map((column) => (
          <KanbanColumn
            key={column.id}
            column={column}
            columns={projectColumns}
            activeColumnId={activeColumnId}
            overColumnId={overColumnId}
            onTaskClick={onTaskClick}
            onCreateTask={onCreateTask}
            projectsMap={projectsMap}
            showProjectDot={showProjectDot}
            disableDrag={disableDrag}
            cardProperties={cardProperties}
            taskTags={taskTags}
            tags={tags}
            blockedTaskIds={blockedTaskIds}
            subTaskCounts={subTaskCounts}
            focusedTaskId={focusedTaskId}
            onCardMouseEnter={setHoveredTaskId}
            cardRefs={cardRefs}
            allProjects={allProjects}
            onUpdateTask={onUpdateTask}
            onArchiveTask={onArchiveTask}
            onDeleteTask={onDeleteTask}
            onArchiveAllTasks={onArchiveAllTasks}
          />
        ))}
      </div>
      </div>
      <DragOverlay
        dropAnimation={reduceMotion ? null : { duration: 33, easing: 'ease-out' }}
      >
        {activeTask ? (
          <motion.div
            initial={reduceMotion ? false : { scale: 0.95, opacity: 0.8 }}
            animate={reduceMotion ? {} : { scale: 1.05, opacity: 1 }}
            transition={reduceMotion ? {} : { type: 'spring', stiffness: 1800, damping: 60 }}
          >
            <KanbanCard
              task={activeTask}
              columns={projectColumns}
              isDragging
              project={showProjectDot ? projectsMap?.get(activeTask.project_id) : undefined}
              showProject={showProjectDot}
            />
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
    </DndContext>
  )
}
