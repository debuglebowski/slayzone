import { useState, type CSSProperties, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, GitBranch, Pin, Power, X } from 'lucide-react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { DraggableSyntheticListeners } from '@dnd-kit/core'
import { useSessionStateRaw } from '@slayzone/terminal'
import {
  cn,
  TerminalProgressDot,
  PriorityIcon,
  getColumnStatusStyle,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '@slayzone/ui'
import { type Task } from '@slayzone/task/shared'
import type { TaskBranchCtx, TaskRowDragData } from './tree-view.types'
import { rowGroupValue } from './tree-view.utils'
import { TreeGuides, tgGuideX, tgPaddingLeft, TG_ROW_HEIGHT } from './tree-guides'

function RenameInput({
  initialValue,
  onCommit,
  onCancel
}: {
  initialValue: string
  onCommit: (value: string) => void
  onCancel: () => void
}): ReactNode {
  const [value, setValue] = useState(initialValue)
  return (
    <input
      autoFocus
      type="text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          onCommit(value)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        }
      }}
      onBlur={() => onCommit(value)}
      className="flex-1 min-w-0 rounded bg-input/40 px-1 py-0.5 text-sm text-foreground outline-none ring-1 ring-ring"
    />
  )
}

/** Props shared by every tree-row component. */
interface TaskRowProps {
  task: Task
  depth: number
  ancestorFlags: boolean[]
  // Set for every row in the temporary group (temp roots AND their subtasks),
  // not just tasks whose own `is_temporary` is set. Drives the DnD dispatch.
  inTempGroup: boolean
  ctx: TaskBranchCtx
}

/**
 * Drag-and-drop wiring a row needs in order to render. Sortable rows fill this
 * from `useSortable`; plain rows (temporary tasks — kept outside the DnD
 * system) pass `INERT_SORTABLE` so they never register a draggable/droppable
 * node or receive slide transforms.
 */
interface RowSortable {
  setNodeRef?: (node: HTMLElement | null) => void
  attributes?: ReturnType<typeof useSortable>['attributes']
  listeners?: DraggableSyntheticListeners
  transform: ReturnType<typeof useSortable>['transform']
  transition?: string
  isDragging: boolean
}

const INERT_SORTABLE: RowSortable = {
  transform: null,
  transition: undefined,
  isDragging: false
}

function TaskRowView({
  task,
  depth,
  ancestorFlags,
  ctx,
  sortable
}: TaskRowProps & { sortable: RowSortable }): ReactNode {
  const isEditing = ctx.editingTaskId === task.id
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = sortable
  // Multi-drag: when the dragged row is part of a multi-selection, every
  // selected row should appear to "lift" together. Hide all selected rows
  // (not just the dragged one) so the floating +N preview is the only
  // visible representation of the moving set.
  const isMultiDragSourceActive =
    ctx.activeDragTaskId !== null &&
    ctx.selectedTaskIds.has(ctx.activeDragTaskId) &&
    ctx.selectedTaskIds.size > 1
  const hideForMultiDrag = isMultiDragSourceActive && ctx.selectedTaskIds.has(task.id)
  const effectivelyHidden = isDragging || hideForMultiDrag

  // While dragging, the floating preview renders via DragOverlay (portal,
  // escapes the project's overflow-hidden clip). Hide source row but keep
  // its layout reserved — verticalListSortingStrategy measures each row's
  // bounding rect to compute sibling slide transforms, so collapsing the
  // source's height (display:none) breaks the animation math.
  const style: CSSProperties = {
    transform: isDragging ? undefined : CSS.Transform.toString(transform),
    transition: isDragging ? undefined : transition,
    opacity: effectivelyHidden ? 0 : 1,
    pointerEvents: effectivelyHidden ? 'none' : undefined
  }

  const isActive = ctx.activeTaskId === task.id
  const isOpenTab = ctx.openTabTaskIds.has(task.id)
  const isSelected = ctx.selectedTaskIds.has(task.id)
  const termState = useSessionStateRaw(`${task.id}:${task.id}`)
  const progress = ctx.taskProgress?.get(task.id)
  const isDone = ctx.doneTaskIds?.has(task.id) ?? false
  const cols = ctx.columnsByProjectId?.get(task.project_id) ?? null
  const statusStyle = getColumnStatusStyle(task.status, cols)
  const StatusIcon = statusStyle?.icon

  const button = (
    <button
      ref={setNodeRef}
      type="button"
      data-sidebar-tree-item="task"
      data-task-id={task.id}
      data-active={isActive ? 'true' : undefined}
      data-selected={isSelected ? 'true' : undefined}
      onClick={(e) => ctx.onRowSelectClick(e, task.id)}
      onAuxClick={(e) => {
        if (e.button !== 1) return
        e.preventDefault()
        e.stopPropagation()
        if (isOpenTab) ctx.onCloseTab?.(task.id)
        else ctx.onOpenTaskInBackground?.(task.id)
      }}
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault()
      }}
      style={{ ...style, paddingLeft: tgPaddingLeft(depth), minHeight: TG_ROW_HEIGHT }}
      className="group/treerow relative flex w-full items-center pr-1 text-sm text-left touch-none"
      {...attributes}
      {...listeners}
    >
      <TreeGuides depth={depth} ancestorFlags={ancestorFlags} />
      {ctx.tasksWithChildren.has(task.id) && (
        <span
          role="button"
          aria-label={ctx.collapsedTaskIds.has(task.id) ? 'Expand sub-tasks' : 'Collapse sub-tasks'}
          tabIndex={0}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            ctx.onToggleCollapse(task.id)
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return
            e.preventDefault()
            e.stopPropagation()
            ctx.onToggleCollapse(task.id)
          }}
          style={{
            // Position at the elbow apex on this row — where the vertical
            // ancestor guide curves to meet the row content. That's the
            // visual "path split". Centered on (parentX, mid).
            left: tgGuideX(depth - 1) - 6,
            top: TG_ROW_HEIGHT / 2 - 6
          }}
          className={cn(
            'absolute z-20 inline-flex size-3 items-center justify-center rounded-sm bg-background text-foreground ring-1 ring-border transition-opacity',
            'opacity-0 group-hover/treerow:opacity-100 hover:bg-accent hover:text-accent-foreground',
            ctx.collapsedTaskIds.has(task.id) && 'opacity-100'
          )}
        >
          {ctx.collapsedTaskIds.has(task.id) ? (
            <ChevronRight className="size-2.5" />
          ) : (
            <ChevronDown className="size-2.5" />
          )}
        </span>
      )}
      <span
        className={cn(
          'relative flex flex-1 items-center gap-2 px-1.5 py-1 min-w-0 transition-colors',
          // Selection = a self-contained border on every selected row (same for
          // any count, rows NOT aware of neighbors). Background + text stay
          // driven purely by active/open state — selecting never changes them.
          // A transparent border is reserved on all rows so selecting causes no
          // 1px layout shift.
          (() => {
            const base = cn(
              'rounded-md border border-transparent',
              isActive
                ? 'bg-white/15 text-foreground'
                : isOpenTab
                  ? 'text-foreground hover:bg-accent/40'
                  : 'text-muted-foreground/45 hover:bg-accent/40 hover:text-accent-foreground'
            )
            return isSelected ? cn(base, 'border-foreground/25') : base
          })()
        )}
      >
        <TerminalProgressDot
          state={termState}
          progress={progress}
          isDone={isDone}
          needsAttention={Boolean(task.needs_attention)}
          pauseOverridesAttention
          alwaysShow
          tooltipSide="right"
          size={8}
          activeSize={12}
        />
        {isEditing ? (
          <RenameInput
            initialValue={task.title || ''}
            onCommit={(v) => ctx.onCommitEdit(task.id, v)}
            onCancel={ctx.onCancelEdit}
          />
        ) : (
          <span
            onDoubleClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              ctx.onStartEdit(task.id)
            }}
            className={cn(
              'truncate flex-1',
              ctx.treeCrossOutDone && isDone && 'line-through text-muted-foreground/60'
            )}
          >
            {task.title || 'Untitled'}
          </span>
        )}
        {task.needs_attention && (
          <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400">
            Unread
          </span>
        )}
        {ctx.treeShowWorktree && task.worktree_path && (
          <GitBranch
            aria-label="Worktree"
            className={cn('size-3.5 shrink-0', !task.worktree_color && 'text-muted-foreground/60')}
            style={task.worktree_color ? { color: task.worktree_color } : undefined}
          />
        )}
        {ctx.pinnedSet.has(task.id) && (
          <Pin
            aria-label="Pinned"
            className="size-3 shrink-0 text-muted-foreground/60 -rotate-45 fill-current"
          />
        )}
        {ctx.treeShowPriority && task.priority != null && (
          <PriorityIcon priority={task.priority} className="size-3.5 shrink-0" />
        )}
        {ctx.treeShowStatus && StatusIcon && (
          <StatusIcon className={cn('size-3.5 shrink-0', statusStyle?.iconClass)} />
        )}
        {isOpenTab && ctx.onCloseTab ? (
          <Tooltip delayDuration={500}>
            <TooltipTrigger asChild>
              <span
                role="button"
                aria-label="Close tab"
                tabIndex={0}
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  ctx.onCloseTab?.(task.id)
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return
                  e.preventDefault()
                  e.stopPropagation()
                  ctx.onCloseTab?.(task.id)
                }}
                className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground shrink-0"
              >
                <X className="size-3.5" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="right">Close tab (middle-click)</TooltipContent>
          </Tooltip>
        ) : !isOpenTab && ctx.onOpenTaskInBackground ? (
          <Tooltip delayDuration={500}>
            <TooltipTrigger asChild>
              <span
                role="button"
                aria-label="Open in background tab"
                tabIndex={0}
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  ctx.onOpenTaskInBackground?.(task.id)
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return
                  e.preventDefault()
                  e.stopPropagation()
                  ctx.onOpenTaskInBackground?.(task.id)
                }}
                className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground opacity-0 group-hover/treerow:opacity-100 focus-visible:opacity-100 transition-opacity shrink-0"
              >
                <Power className="size-3" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="right">Open in background tab (middle-click)</TooltipContent>
          </Tooltip>
        ) : (
          <span aria-hidden className="inline-block size-5 shrink-0" />
        )}
      </span>
    </button>
  )

  const isInBulk = isSelected && ctx.selectedTaskIds.size > 1
  let wrapped: ReactNode = button
  if (isInBulk && ctx.taskBulkContextMenuRender) {
    wrapped = ctx.taskBulkContextMenuRender(ctx.selectedTaskIdArr, button)
  } else if (ctx.taskContextMenuRender) {
    wrapped = ctx.taskContextMenuRender(task, button)
  }
  return <div>{wrapped}</div>
}

/**
 * Sortable variant — the normal case. Owns the `useSortable` binding so
 * `TaskRowView` stays presentational and `PlainTaskRow` can skip the hook.
 */
function SortableTaskRow(props: TaskRowProps): ReactNode {
  const { task, ctx } = props
  const isEditing = ctx.editingTaskId === task.id
  const draggable = ctx.dragEnabled && !isEditing
  const dragData: TaskRowDragData = {
    kind: 'task',
    projectId: task.project_id,
    groupValue: rowGroupValue(task, ctx.treeGroupBy, ctx.treeGroupPinned, ctx.pinnedSet),
    parentId: task.parent_id ?? null
  }
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: dragData,
    disabled: !draggable
  })
  return (
    <TaskRowView
      {...props}
      sortable={{ setNodeRef, attributes, listeners, transform, transition, isDragging }}
    />
  )
}

/**
 * Plain variant for temporary tasks — no `useSortable`, no drag listeners, not
 * a drop target. Temp rows also sit outside `SortableContext` (see
 * `buildRowList`), so they neither drag nor slide during others' drags.
 */
function PlainTaskRow(props: TaskRowProps): ReactNode {
  return <TaskRowView {...props} sortable={INERT_SORTABLE} />
}

/**
 * Dispatcher. The whole temporary group is excluded from drag-and-drop —
 * keyed on `inTempGroup` (group membership), not the task's own
 * `is_temporary`, so a non-temp subtask of a temp root is excluded too.
 * Returning a distinct component type per branch also makes React remount
 * cleanly if a row crosses the boundary (temp task promoted to permanent),
 * avoiding a hook-count mismatch from a conditional `useSortable`.
 */
export function TaskRow(props: TaskRowProps): ReactNode {
  return props.inTempGroup ? <PlainTaskRow {...props} /> : <SortableTaskRow {...props} />
}
