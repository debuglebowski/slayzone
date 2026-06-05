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
import { arrayMove } from '@dnd-kit/sortable'
import type { Task } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'
import type { ColumnConfig } from '@slayzone/projects/shared'
import { groupTasksBy, columnToCreateTaskDraft, type Column } from './kanban'
import type { ViewConfig, CardProperties } from './FilterState'
import type { Tag } from '@slayzone/tags/shared'
import { useActiveTaskIds } from '@slayzone/terminal'
import { useDialogStore } from '@slayzone/settings/client'
import { GroupSection } from './KanbanGroupSection'
import { computeSubTaskCounts, splitActiveInactiveColumns } from './KanbanListView.utils'

// ── Types ──

interface KanbanListViewProps {
  tasks: Task[]
  columns?: ColumnConfig[] | null
  viewConfig: ViewConfig
  onTaskMove: (taskId: string, newColumnId: string, targetIndex: number) => void
  onTaskReorder: (taskIds: string[]) => void
  onTaskClick?: (task: Task, e: { metaKey: boolean }) => void
  cardProperties?: CardProperties
  blockedTaskIds?: Set<string>
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

// ── Main component ──

export function KanbanListView({
  tasks,
  columns: projectColumns,
  viewConfig,
  onTaskMove,
  onTaskReorder,
  onTaskClick,
  cardProperties,
  blockedTaskIds,
  allProjects,
  onUpdateTask,
  onArchiveTask,
  onDeleteTask,
  tags,
  taskTags,
  onTaskTagsChange,
  activeAgentTaskIds,
  onShutdownAgent
}: KanbanListViewProps): React.JSX.Element {
  const { groupBy, sortBy, showEmptyColumns } = viewConfig

  const handleCreateTask = useMemo(() => {
    return (column: Column) =>
      useDialogStore.getState().openCreateTask(columnToCreateTaskDraft(column, groupBy))
  }, [groupBy])
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
    const base = groupTasksBy(tasks, groupBy, sortBy, projectColumns, {
      blockedTaskIds,
      viewConfig
    })
    if (shouldTrackActive && base.length === 1) {
      return splitActiveInactiveColumns(base[0].tasks, activeTaskIds, showEmptyColumns)
    }
    return base
  }, [tasks, projectColumns, groupBy, sortBy, shouldTrackActive, showEmptyColumns, activeTaskIds])

  const visibleColumns = showEmptyColumns
    ? allColumns
    : allColumns.filter((c) => c.tasks.length > 0)
  const activeTask = activeId ? tasks.find((t) => t.id === activeId) : null

  const subTaskCounts = useMemo(
    () => computeSubTaskCounts(tasks, projectColumns),
    [tasks, projectColumns]
  )

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

    // Dropped on a group droppable (empty or non-empty group area)
    const groupPrefix = 'group:'
    if (overId.startsWith(groupPrefix)) {
      const columnId = overId.slice(groupPrefix.length)
      const sourceColumn = visibleColumns.find((c) => c.tasks.some((t) => t.id === taskId))
      const targetColumn = visibleColumns.find((c) => c.id === columnId)
      if (!sourceColumn || !targetColumn) return
      if (targetColumn.id === '__unknown__' || sourceColumn.id === targetColumn.id) return
      onTaskMove(taskId, targetColumn.id, targetColumn.tasks.length)
      return
    }

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
            onCreateTask={handleCreateTask}
            cp={cardProperties}
            onTaskClick={onTaskClick}
            disableDrag={disableDrag}
            blockedTaskIds={blockedTaskIds}
            subTaskCounts={subTaskCounts}
            isDragging={activeId != null}
            allProjects={allProjects}
            onUpdateTask={onUpdateTask}
            onArchiveTask={onArchiveTask}
            onDeleteTask={onDeleteTask}
            tags={tags}
            taskTags={taskTags}
            onTaskTagsChange={onTaskTagsChange}
            activeAgentTaskIds={activeAgentTaskIds}
            onShutdownAgent={onShutdownAgent}
          />
        ))}
      </div>
      <DragOverlay>
        {activeTask ? (
          <div className="rounded-md bg-surface-1 border px-2.5 py-1.5 shadow-lg text-xs font-medium opacity-90">
            {activeTask.title}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}
