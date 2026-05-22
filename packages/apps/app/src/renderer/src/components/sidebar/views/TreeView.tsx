import {
  useCallback,
  useMemo,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from 'react'
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Clock,
  GitBranch,
  Home,
  Pin,
  Plus,
  Power,
  Search,
  Settings,
  X
} from 'lucide-react'
import * as Collapsible from '@radix-ui/react-collapsible'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DraggableSyntheticListeners,
  type DragEndEvent,
  type DragStartEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  cn,
  TerminalProgressDot,
  PriorityIcon,
  getColumnStatusStyle,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useShortcutDisplay
} from '@slayzone/ui'
import { type Task } from '@slayzone/task/shared'
import { useDialogStore, useTabStore } from '@slayzone/settings'
import { PRIORITY_LABELS } from '@slayzone/tasks'
import {
  groupTreeRows,
  orderTreeRows,
  PINNED_GROUP_KEY,
  NONE_GROUP_KEY,
  type TreeGroup
} from './treeGrouping'
import { useActiveSessionTaskIds } from '@/components/agent-status/useIdleTasks'
import { useStaleSkillCounts } from '@slayzone/ai-config/client'
import { TreeDisplaySettings } from '../TreeDisplaySettings'
import logo from '@/assets/logo.svg'
import type { SidebarViewContext } from './types'

function ContextStaleDot({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <span
      aria-label={`${count} stale skill${count === 1 ? '' : 's'}`}
      data-testid="context-manager-stale-dot"
      className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-amber-500"
    />
  )
}

// Tree guide layout (mirrors EditorToc / ManagerSidebar).
const TG_INDENT = 22
const TG_ROW_HEIGHT = 32
const TG_CURVE_R = 5
const TG_ELBOW_END_OFFSET = 7
const TG_ROOT_X = 15
const TG_TEXT_GAP_AFTER_CURVE = 2
const tgGuideX = (ancestorDepth: number) => TG_ROOT_X + TG_INDENT * ancestorDepth
const tgPaddingLeft = (depth: number) =>
  depth === 0 ? TG_ROOT_X : tgGuideX(depth - 1) + TG_ELBOW_END_OFFSET + TG_TEXT_GAP_AFTER_CURVE

function TreeGuides({
  depth,
  ancestorFlags
}: {
  depth: number
  ancestorFlags: boolean[]
}): ReactNode {
  if (depth <= 0) return null
  const parentX = tgGuideX(depth - 1)
  const mid = TG_ROW_HEIGHT / 2
  const r = TG_CURVE_R
  const endX = parentX + TG_ELBOW_END_OFFSET
  const continueBelow = ancestorFlags[depth - 1] ?? false
  const connector =
    `M ${parentX} 0 V ${mid - r} Q ${parentX} ${mid} ${parentX + r} ${mid} H ${endX}` +
    (continueBelow ? ` M ${parentX} ${mid - r} V ${TG_ROW_HEIGHT}` : '')
  const svgWidth = endX + 2
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute top-0 left-0 text-border"
      width={svgWidth}
      height={TG_ROW_HEIGHT}
    >
      {ancestorFlags
        .slice(0, -1)
        .map((flag, a) =>
          flag ? (
            <line
              key={a}
              x1={tgGuideX(a)}
              x2={tgGuideX(a)}
              y1={0}
              y2={TG_ROW_HEIGHT}
              stroke="currentColor"
              strokeWidth={1}
            />
          ) : null
        )}
      <path d={connector} fill="none" stroke="currentColor" strokeWidth={1} />
    </svg>
  )
}

interface TaskRowDragData {
  kind: 'task'
  projectId: string
  /** Either a status id or 'p1'..'p5' depending on treeGroupBy. */
  groupValue: string
  parentId: string | null
}

interface GroupDropData {
  kind: 'group'
  projectId: string
  groupValue: string
}

interface ProjectDragData {
  kind: 'project'
}

interface TaskBranchCtx {
  childrenByParent: Map<string, Task[]>
  activeTaskId: string | null
  openTabTaskIds: Set<string>
  doneTaskIds?: Set<string>
  terminalStates?: Map<string, import('@slayzone/terminal/shared').TerminalState>
  taskProgress?: Map<string, number>
  columnsByProjectId?: Map<string, import('@slayzone/projects/shared').ColumnConfig[] | null>
  pinnedSet: Set<string>
  selectedTaskIds: Set<string>
  selectedTaskIdArr: string[]
  /** For each selected task, whether it sits at the top/bottom of its
   * contiguous selection run in the project's render order. Used to draw a
   * single subtle border around the run when multi-selecting. Empty when
   * fewer than 2 tasks are selected. */
  selectionRunInfo: Map<string, { firstInRun: boolean; lastInRun: boolean }>
  /** Id of the currently-dragged row (null when no drag). Used so all rows
   * in a multi-drag can hide together — the dragged row plus every other
   * selected row vanishes while the floating preview shows the count. */
  activeDragTaskId: string | null
  treeShowStatus: boolean
  treeShowPriority: boolean
  treeShowWorktree: boolean
  treeCrossOutDone: boolean
  treeGroupBy: 'none' | 'status' | 'priority'
  treeGroupPinned: boolean
  onTaskClick?: (taskId: string) => void
  onRowSelectClick: (event: ReactMouseEvent<HTMLButtonElement>, taskId: string) => void
  onCloseTab?: (taskId: string) => void
  onOpenTaskInBackground?: (taskId: string) => void
  taskContextMenuRender?: SidebarViewContext['taskContextMenuRender']
  taskBulkContextMenuRender?: SidebarViewContext['taskBulkContextMenuRender']
  dragEnabled: boolean
  editingTaskId: string | null
  onStartEdit: (taskId: string) => void
  onCommitEdit: (taskId: string, value: string) => void
  onCancelEdit: () => void
  /** Tasks that have at least one visible child in the tree — render
   * collapse chevron. Computed from the un-collapse-filtered child map so
   * collapsing a parent doesn't hide its own chevron. */
  tasksWithChildren: Set<string>
  collapsedTaskIds: Set<string>
  onToggleCollapse: (taskId: string) => void
}

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

function rowGroupValue(
  task: Task,
  groupBy: 'none' | 'status' | 'priority',
  groupPinned: boolean,
  pinnedSet: Set<string>
): string {
  if (groupPinned && pinnedSet.has(task.id)) return PINNED_GROUP_KEY
  if (groupBy === 'none') return NONE_GROUP_KEY
  if (groupBy === 'priority') return `p${typeof task.priority === 'number' ? task.priority : 5}`
  return task.status
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
  const termState = ctx.terminalStates?.get(task.id)
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
          // Selection visuals: single = bold ring; multi = subtle bg + a single
          // border around contiguous run. Run-position (first/last) controls
          // which sides get borders + corner rounding so adjacent selected
          // rows fuse into one outlined block.
          (() => {
            if (!isSelected) {
              return cn(
                'rounded-md',
                isActive
                  ? 'bg-white/10 text-foreground'
                  : isOpenTab
                    ? 'text-foreground hover:bg-accent/40'
                    : 'text-muted-foreground/45 hover:bg-accent/40 hover:text-accent-foreground'
              )
            }
            const isMulti = ctx.selectedTaskIds.size > 1
            if (!isMulti) {
              return 'rounded-md bg-accent/60 text-accent-foreground ring-1 ring-accent ring-inset'
            }
            const run = ctx.selectionRunInfo.get(task.id)
            const first = run?.firstInRun ?? true
            const last = run?.lastInRun ?? true
            return cn(
              'bg-accent/30 text-foreground border-l border-r border-foreground/25',
              first && 'border-t',
              last && 'border-b',
              first && last && 'rounded-md',
              first && !last && 'rounded-t-md rounded-b-none',
              !first && last && 'rounded-b-md rounded-t-none',
              !first && !last && 'rounded-none'
            )
          })()
        )}
      >
        <TerminalProgressDot
          state={termState}
          progress={progress}
          isDone={isDone}
          needsAttention={Boolean(task.needs_attention)}
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
function TaskRow(props: TaskRowProps): ReactNode {
  return props.inTempGroup ? <PlainTaskRow {...props} /> : <SortableTaskRow {...props} />
}

// Floating drag preview — renders portal'd to document.body via DragOverlay,
// so it escapes the project's `overflow-hidden` collapsible wrapper. Without
// this, the dragged row's transform is clipped at the project boundary and
// vanishes after a few pixels of motion.
function TaskDragPreview({ tasks }: { tasks: Task[] }): ReactNode {
  if (tasks.length === 0) return null
  const lead = tasks[0]
  const extra = tasks.length - 1
  const isMulti = extra > 0
  // Single-row card with source title + "+N" chip. When multi, two thin peeks
  // behind hint at the stack without making a heavy visual.
  return (
    <div className="relative">
      {isMulti && (
        <>
          <div
            aria-hidden
            className="absolute inset-0 -z-10 translate-x-1 translate-y-1 rounded-md bg-surface-2/60 ring-1 ring-border/60"
          />
          <div
            aria-hidden
            className="absolute inset-0 -z-20 translate-x-2 translate-y-2 rounded-md bg-surface-2/30 ring-1 ring-border/40"
          />
        </>
      )}
      <div className="relative flex items-center gap-2 rounded-md bg-surface-2/95 px-2 py-1 text-sm text-foreground shadow-lg ring-1 ring-border min-h-[28px]">
        <TerminalProgressDot
          state={undefined}
          progress={undefined}
          isDone={false}
          needsAttention={Boolean(lead.needs_attention)}
          alwaysShow
        />
        <span className="truncate max-w-[260px]">{lead.title || 'Untitled'}</span>
        {isMulti && (
          <span className="shrink-0 rounded bg-foreground/10 text-muted-foreground px-1.5 py-0.5 text-[10px] font-medium tabular-nums">
            +{extra}
          </span>
        )}
      </div>
    </div>
  )
}

/** Floating preview shown in the DragOverlay while a project is being
 *  reordered — a compact header chip (color swatch + name), mirroring the
 *  "lift the card out" feel of {@link TaskDragPreview}. */
function ProjectDragPreview({
  project
}: {
  project: { name: string; color: string }
}): ReactNode {
  return (
    <div className="flex h-10 items-center gap-2 rounded-lg bg-surface-2/95 px-2.5 text-sm font-semibold text-foreground shadow-lg ring-1 ring-border">
      <span
        aria-hidden
        className="size-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: project.color }}
      />
      <span className="truncate max-w-[220px]">{project.name}</span>
    </div>
  )
}

interface HeaderRowProps {
  rowId: string
  projectId: string
  group: TreeGroup
  padTopClass: string
  cols: import('@slayzone/projects/shared').ColumnConfig[] | null
  treeGroupBy: 'none' | 'status' | 'priority'
  onCreateTemporaryTask?: (projectId: string) => void
}

/** DnD wiring for a header row; the temporary header passes an inert object. */
interface HeaderSortable {
  setNodeRef?: (node: HTMLElement | null) => void
  transform: ReturnType<typeof useSortable>['transform']
  transition?: string
  isOver: boolean
}

function HeaderRowView({
  projectId,
  group,
  padTopClass,
  cols,
  treeGroupBy,
  onCreateTemporaryTask,
  sortable
}: HeaderRowProps & { sortable: HeaderSortable }): ReactNode {
  const { setNodeRef, transform, transition, isOver } = sortable
  // Status/priority headers are drop targets — a drop routes through the
  // `kind: 'group'` branch in `handleDragEnd`, landing the dragged set at
  // index 0 of the group. Pinned/none/temp headers reject drops.
  const isDroppable = !group.isTemp && !group.isPinned && !group.isNone

  let label: string
  let Icon: typeof Clock | null = null
  let iconClass: string | undefined
  if (group.isPinned) {
    label = 'Pinned'
    Icon = Pin
    iconClass = 'text-muted-foreground/60 -rotate-45 fill-current'
  } else if (group.isTemp) {
    label = 'Temporary'
    Icon = Clock
    iconClass = 'text-muted-foreground/60'
  } else if (group.isNone) {
    label = 'Other'
  } else if (treeGroupBy === 'priority') {
    const prio = parseInt(group.key.slice(1), 10)
    label = PRIORITY_LABELS[prio] ?? group.key
  } else {
    const style = getColumnStatusStyle(group.key, cols)
    label = style?.label ?? group.key
    Icon = style?.icon ?? null
    iconClass = style?.iconClass
  }

  const showAdd = !group.isPinned && !group.isNone && !(group.isTemp && !onCreateTemporaryTask)

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition
      }}
      data-sidebar-tree-item="header"
      data-group-key={group.key}
      data-testid={isDroppable ? 'tree-status-group' : undefined}
      data-project-id={projectId}
      data-status={group.key}
      className={cn(
        'flex items-center gap-1.5 px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60 transition-colors',
        padTopClass,
        isOver && isDroppable && 'bg-accent/15 rounded-md ring-1 ring-accent/30'
      )}
    >
      {Icon && <Icon className={cn('size-3', iconClass)} />}
      <span>{label}</span>
      {showAdd && (
        <button
          type="button"
          onClick={() => {
            if (group.isTemp) {
              onCreateTemporaryTask?.(projectId)
              return
            }
            if (treeGroupBy === 'priority') {
              const prio = parseInt(group.key.slice(1), 10)
              useDialogStore.getState().openCreateTask({
                projectId,
                priority: Number.isFinite(prio) ? prio : undefined
              })
              return
            }
            useDialogStore.getState().openCreateTask({
              projectId,
              status: group.key as Task['status']
            })
          }}
          aria-label={`New ${group.isTemp ? 'temporary ' : ''}task in ${label}`}
          className="ml-auto inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 hover:bg-accent/40 hover:text-foreground transition-colors"
        >
          <Plus className="size-3" />
        </button>
      )}
    </div>
  )
}

/**
 * Sortable header — a tween-only participant (slides with surrounding rows
 * during pre-slide) and, for status/priority groups, a drop target.
 * `draggable: true` disables drag listeners — headers slide, never drag.
 */
function SortableHeaderRow(props: HeaderRowProps): ReactNode {
  const { rowId, projectId, group } = props
  const isDroppable = !group.isTemp && !group.isPinned && !group.isNone
  const { setNodeRef, transform, transition, isOver } = useSortable({
    id: rowId,
    data: { kind: 'group', projectId, groupValue: group.key } satisfies GroupDropData,
    disabled: { draggable: true, droppable: !isDroppable }
  })
  return <HeaderRowView {...props} sortable={{ setNodeRef, transform, transition, isOver }} />
}

/** Plain header for the temporary group — kept outside the DnD system. */
function PlainHeaderRow(props: HeaderRowProps): ReactNode {
  return (
    <HeaderRowView
      {...props}
      sortable={{ transform: null, transition: undefined, isOver: false }}
    />
  )
}

/** Dispatcher — the temporary group's header skips `useSortable` entirely. */
function HeaderRow(props: HeaderRowProps): ReactNode {
  return props.group.isTemp ? <PlainHeaderRow {...props} /> : <SortableHeaderRow {...props} />
}

type RowItem =
  | { kind: 'header'; rowId: string; group: TreeGroup; padTopClass: string }
  | {
      kind: 'task'
      rowId: string
      task: Task
      depth: number
      ancestorFlags: boolean[]
      // True for every row inside the temporary group, including non-temp
      // subtasks of a temp root — so the whole subtree stays out of DnD.
      inTempGroup: boolean
    }

/**
 * Wraps a project block in a sortable. `renderProject` is a `.map` closure, so
 * a hook can't be called inside it directly — this real component provides the
 * `useSortable` binding via render-prop. `setNodeRef`/`style` go on the project
 * `Collapsible.Root` (the whole block translates); `listeners` go on the header
 * row so the whole header is the grab area. Drag is disabled unless `showAll`
 * (the only mode where the full project list — and thus a complete reorder — is
 * visible). Id is prefixed `project:` so it never collides with task/header ids.
 */
function SortableProject({
  projectId,
  disabled,
  children
}: {
  projectId: string
  disabled: boolean
  children: (args: {
    setNodeRef: (el: HTMLElement | null) => void
    style: CSSProperties
    listeners: DraggableSyntheticListeners
    isDragging: boolean
  }) => ReactNode
}) {
  const { setNodeRef, transform, transition, listeners, isDragging } = useSortable({
    id: `project:${projectId}`,
    data: { kind: 'project' } satisfies ProjectDragData,
    disabled
  })
  // While dragging, the floating preview renders via DragOverlay — hide the
  // source block (opacity 0) but keep its layout reserved so
  // verticalListSortingStrategy can measure rects for the sibling slide.
  const style: CSSProperties = {
    transform: isDragging ? undefined : CSS.Transform.toString(transform),
    transition: isDragging ? undefined : transition,
    opacity: isDragging ? 0 : 1,
    pointerEvents: isDragging ? 'none' : undefined
  }
  return <>{children({ setNodeRef, style, listeners, isDragging })}</>
}

export function TreeView({
  projects,
  tasks,
  selectedProjectId,
  onSelectProject,
  onProjectSettings,
  onTaskClick,
  onCloseTab,
  onOpenTaskInBackground,
  onCreateTemporaryTask,
  taskContextMenuRender,
  taskBulkContextMenuRender,
  terminalStates,
  taskProgress,
  doneTaskIds,
  columnsByProjectId,
  onTaskReorder,
  onTaskMove,
  onTaskReparent,
  onTaskBulkReparent,
  onTaskFieldUpdate,
  onTaskBulkFieldUpdate,
  onReorderProjects,
  onSetTasksPinned,
  onSetCollapsed,
  onPinnedReorder
}: SidebarViewContext) {
  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
    [projects]
  )

  const treeStatusFilter = useTabStore((s) => s.treeStatusFilter)
  const statusFilter = useMemo(() => new Set(treeStatusFilter), [treeStatusFilter])
  const treePriorityFilter = useTabStore((s) => s.treePriorityFilter)
  const priorityFilter = useMemo(() => new Set(treePriorityFilter), [treePriorityFilter])
  const treeShowStatus = useTabStore((s) => s.treeShowStatus)
  const treeShowPriority = useTabStore((s) => s.treeShowPriority)
  const treeShowSubtasks = useTabStore((s) => s.treeShowSubtasks)
  const treeIncludeAllSubtasks = useTabStore((s) => s.treeShowAllSubtasks)
  const treeIncludeAllUndoneSubtasks = useTabStore((s) => s.treeShowAllUndoneSubtasks)
  const treeCrossOutDone = useTabStore((s) => s.treeCrossOutDone)
  const treeShowOnlyActive = useTabStore((s) => s.treeShowOnlyActive)
  const treeShowTemporary = useTabStore((s) => s.treeShowTemporary)
  const treeShowBlocked = useTabStore((s) => s.treeShowBlocked)
  const treeShowSnoozed = useTabStore((s) => s.treeShowSnoozed)
  const treeShowAllOpen = useTabStore((s) => s.treeShowAllOpen)
  const treeShowWorktree = useTabStore((s) => s.treeShowWorktree)
  // Pinned / collapsed are task-intrinsic columns (tasks.pinned / tree_collapsed)
  // — derived straight from the task list so optimistic updates flow through.
  const pinnedSet = useMemo(
    () => new Set(tasks.filter((t) => t.pinned).map((t) => t.id)),
    [tasks]
  )
  const collapsedSet = useMemo(
    () => new Set(tasks.filter((t) => t.tree_collapsed).map((t) => t.id)),
    [tasks]
  )
  const handleToggleCollapse = useCallback(
    (taskId: string) => {
      onSetCollapsed?.(taskId, !collapsedSet.has(taskId))
    },
    [onSetCollapsed, collapsedSet]
  )
  // Hoisted above `childrenByParent` memo so it can react to drag start —
  // dragging a parent transiently collapses its sub-tasks.
  const [activeDragTaskId, setActiveDragTaskId] = useState<string | null>(null)
  // Project id (not prefixed) currently being drag-reordered, or null.
  const [activeDragProjectId, setActiveDragProjectId] = useState<string | null>(null)
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(() => new Set())
  const selectedTaskIdArr = useMemo(() => [...selectedTaskIds], [selectedTaskIds])
  const treeGroupBy = useTabStore((s) => s.treeGroupBy)
  const treeOrderBy = useTabStore((s) => s.treeOrderBy)
  const treeOrderDir = useTabStore((s) => s.treeOrderDir)
  const treeGroupTemporary = useTabStore((s) => s.treeGroupTemporary)
  const treeGroupPinned = useTabStore((s) => s.treeGroupPinned)
  const treeShowEmptyGroups = useTabStore((s) => s.treeShowEmptyGroups)

  const tabs = useTabStore((s) => s.tabs)
  const openTabTaskIds = useMemo(() => {
    const ids = new Set<string>()
    for (const t of tabs) if (t.type === 'task') ids.add(t.taskId)
    return ids
  }, [tabs])
  const sessionTaskIds = useActiveSessionTaskIds()

  const passesFilter = useCallback(
    (t: Task) => {
      if (t.archived_at) return false
      // Priority filter is universal — applies even to pinned/open-tab/session
      // tasks. Empty set = no constraint.
      const priorityOk = priorityFilter.size === 0 || priorityFilter.has(t.priority)
      if (!priorityOk) return false
      // Shortcuts: any of these passes the task straight through, bypassing
      // temp/blocked/snoozed, show-only-active, and status filters.
      if (pinnedSet.has(t.id)) return true
      if (sessionTaskIds.has(t.id)) return true
      if (treeShowAllOpen && openTabTaskIds.has(t.id)) return true
      if (!treeShowTemporary && t.is_temporary) return false
      if (!treeShowBlocked && t.is_blocked) return false
      if (!treeShowSnoozed && !!t.snoozed_until && new Date(t.snoozed_until) > new Date())
        return false
      if (treeShowOnlyActive) return false
      return statusFilter.has(t.status)
    },
    [
      statusFilter,
      priorityFilter,
      pinnedSet,
      openTabTaskIds,
      sessionTaskIds,
      treeShowOnlyActive,
      treeShowTemporary,
      treeShowBlocked,
      treeShowSnoozed,
      treeShowAllOpen
    ]
  )

  // A task is "visible" if it passes the filter OR if any descendant in the same
  // project does (so the hierarchy stays connected when only sub-tasks match).
  // Walk parents from each matching task up to the project root.
  //
  // When `treeIncludeAllSubtasks` is on (and sub-tasks are shown), the filter is
  // applied at the root level only — any root that passes pulls its entire
  // descendant subtree along, regardless of sub-task status.
  const visibleTaskIds = useMemo(() => {
    const taskById = new Map(tasks.map((t) => [t.id, t]))
    const set = new Set<string>()

    // `treeShowOnlyActive` takes precedence — when on, skip the all-subtasks
    // expansion so only bypass tasks (pinned/session/open-tab) + parent chain
    // remain visible, regardless of root status match.
    if (
      treeShowSubtasks &&
      !treeShowOnlyActive &&
      (treeIncludeAllSubtasks || treeIncludeAllUndoneSubtasks)
    ) {
      const excludeDone = !treeIncludeAllSubtasks && treeIncludeAllUndoneSubtasks
      const childrenOf = new Map<string, Task[]>()
      for (const t of tasks) {
        if (!t.parent_id) continue
        const list = childrenOf.get(t.parent_id) ?? []
        list.push(t)
        childrenOf.set(t.parent_id, list)
      }
      const isSnoozed = (x: Task) => !!x.snoozed_until && new Date(x.snoozed_until) > new Date()
      for (const t of tasks) {
        if (t.parent_id) continue
        if (t.archived_at) continue
        if (!treeShowTemporary && t.is_temporary) continue
        if (!treeShowBlocked && t.is_blocked) continue
        if (!treeShowSnoozed && isSnoozed(t)) continue
        // Strict root check — must directly match status + priority. Bypasses
        // (open tab, pinned, session) don't qualify a root to pull in its
        // subtree.
        if (priorityFilter.size > 0 && !priorityFilter.has(t.priority)) continue
        if (!statusFilter.has(t.status)) continue
        const stack: Task[] = [t]
        while (stack.length > 0) {
          const cur = stack.pop()!
          if (set.has(cur.id) || cur.archived_at) continue
          // Root passes filter, so include regardless of done. Descendants only
          // gated by excludeDone — keeps a matching root visible even if done.
          if (excludeDone && cur.id !== t.id && doneTaskIds?.has(cur.id)) continue
          // Priority filter applies to descendants too.
          if (cur.id !== t.id && priorityFilter.size > 0 && !priorityFilter.has(cur.priority))
            continue
          // Blocked/snoozed filters apply to descendants too.
          if (cur.id !== t.id && !treeShowBlocked && cur.is_blocked) continue
          if (cur.id !== t.id && !treeShowSnoozed && isSnoozed(cur)) continue
          set.add(cur.id)
          const kids = childrenOf.get(cur.id)
          if (kids) for (const k of kids) stack.push(k)
        }
      }
      // Individual tasks (root or sub-task) that pass via bypass (e.g.
      // open-tab) but whose strict-root subtree wasn't pulled in. Include the
      // task itself + parent chain so the row shows and stays connected.
      for (const t of tasks) {
        if (set.has(t.id) || t.archived_at) continue
        if (!passesFilter(t)) continue
        let cur: Task | undefined = t
        while (cur && !set.has(cur.id) && !cur.archived_at) {
          set.add(cur.id)
          cur = cur.parent_id ? taskById.get(cur.parent_id) : undefined
        }
      }
      return set
    }

    for (const t of tasks) {
      if (!passesFilter(t)) continue
      // When sub-tasks hidden, only top-level tasks are eligible.
      if (!treeShowSubtasks && t.parent_id) continue
      let cur: Task | undefined = t
      while (cur && !set.has(cur.id)) {
        set.add(cur.id)
        if (!treeShowSubtasks) break
        cur = cur.parent_id ? taskById.get(cur.parent_id) : undefined
      }
    }
    return set
  }, [
    tasks,
    passesFilter,
    treeShowSubtasks,
    treeIncludeAllSubtasks,
    treeIncludeAllUndoneSubtasks,
    treeShowOnlyActive,
    doneTaskIds,
    priorityFilter,
    statusFilter,
    treeShowTemporary,
    treeShowBlocked,
    treeShowSnoozed
  ])

  // Visible tasks bucketed and sorted per project using the tree-local order
  // (no coupling to kanban filter). orderTreeRows always tiebreaks by `order`
  // col so manual drag-reorder persists under any orderBy.
  const tasksByProject = useMemo(() => {
    const grouped = new Map<string, Task[]>()
    for (const t of tasks) {
      if (!visibleTaskIds.has(t.id)) continue
      const arr = grouped.get(t.project_id) ?? []
      arr.push(t)
      grouped.set(t.project_id, arr)
    }
    const sorted = new Map<string, Task[]>()
    for (const [pid, arr] of grouped) {
      sorted.set(pid, orderTreeRows(arr, treeOrderBy, treeOrderDir))
    }
    return sorted
  }, [tasks, visibleTaskIds, treeOrderBy, treeOrderDir])

  // For each in-progress task id → its in-progress children, in the
  // per-project sort order. Subtasks whose parent is not in-progress are
  // promoted to the project root.
  //
  // Two maps: `allChildrenByParent` is collapse-agnostic (drives the chevron
  // visibility — collapsed parent still has a chevron). `childrenByParent`
  // drops entries for collapsed parents so render + drag-flat skip those
  // subtrees in one sweep.
  const allChildrenByParent = useMemo(() => {
    if (!treeShowSubtasks) return new Map<string, Task[]>()
    const m = new Map<string, Task[]>()
    for (const arr of tasksByProject.values()) {
      for (const t of arr) {
        const pid = t.parent_id
        if (pid && visibleTaskIds.has(pid)) {
          const list = m.get(pid) ?? []
          list.push(t)
          m.set(pid, list)
        }
      }
    }
    return m
  }, [tasksByProject, visibleTaskIds, treeShowSubtasks])

  const tasksWithChildren = useMemo(() => {
    const s = new Set<string>()
    for (const [pid, kids] of allChildrenByParent) if (kids.length > 0) s.add(pid)
    return s
  }, [allChildrenByParent])

  // Transient collapse set: while a row with sub-tasks is being dragged,
  // hide its children so the drag preview + sortable list stay compact.
  // Restored on drag end/cancel (state cleared in those handlers).
  const dragCollapseSet = useMemo(() => {
    if (!activeDragTaskId) return null
    const isMulti = selectedTaskIds.has(activeDragTaskId) && selectedTaskIds.size > 1
    const ids = isMulti ? selectedTaskIds : new Set([activeDragTaskId])
    const s = new Set<string>()
    for (const id of ids) if (tasksWithChildren.has(id)) s.add(id)
    return s.size > 0 ? s : null
  }, [activeDragTaskId, selectedTaskIds, tasksWithChildren])

  const childrenByParent = useMemo(() => {
    if (collapsedSet.size === 0 && !dragCollapseSet) return allChildrenByParent
    const m = new Map<string, Task[]>()
    for (const [pid, kids] of allChildrenByParent) {
      if (collapsedSet.has(pid)) continue
      if (dragCollapseSet?.has(pid)) continue
      m.set(pid, kids)
    }
    return m
  }, [allChildrenByParent, collapsedSet, dragCollapseSet])

  const rootTasksByProject = useMemo(() => {
    const m = new Map<string, Task[]>()
    for (const [pid, arr] of tasksByProject) {
      const roots: Task[] = []
      for (const t of arr) {
        // When subtasks hidden, render every matched task at the root level.
        const isOrphan = !treeShowSubtasks || !t.parent_id || !visibleTaskIds.has(t.parent_id)
        if (isOrphan) roots.push(t)
      }
      m.set(pid, roots)
    }
    return m
  }, [tasksByProject, visibleTaskIds, treeShowSubtasks])

  // Root tasks grouped by treeGroupBy per project. groupTreeRows handles
  // temp segregation + empty-group rendering.
  const rootGroupsByProject = useMemo(() => {
    const result = new Map<string, TreeGroup[]>()
    for (const [pid, roots] of rootTasksByProject) {
      const cols = columnsByProjectId?.get(pid) ?? null
      const groups = groupTreeRows(roots, treeGroupBy, cols, {
        showEmpty: treeShowEmptyGroups,
        statusFilter,
        groupTemporary: treeGroupTemporary,
        groupPinned: treeGroupPinned,
        pinnedIds: pinnedSet
      })
      // The pinned group's manual order is task-intrinsic (`pin_order`), not the
      // shared `order` col — re-sort it on that key.
      const pinnedGroup = groups.find((g) => g.isPinned)
      if (pinnedGroup) {
        pinnedGroup.tasks = orderTreeRows(
          pinnedGroup.tasks,
          treeOrderBy,
          treeOrderDir,
          'pin_order'
        )
      }
      result.set(pid, groups)
    }
    return result
  }, [
    rootTasksByProject,
    columnsByProjectId,
    treeGroupBy,
    treeShowEmptyGroups,
    statusFilter,
    treeGroupTemporary,
    treeGroupPinned,
    pinnedSet,
    treeOrderBy,
    treeOrderDir
  ])

  const activeTaskId = useTabStore((s) => {
    const tab = s.tabs[s.activeTabIndex]
    return tab?.type === 'task' ? tab.taskId : null
  })
  const activeTabType = useTabStore((s) => s.tabs[s.activeTabIndex]?.type)
  const activeView = useTabStore((s) => s.activeView)
  const projectIsActive = (pid: string) =>
    selectedProjectId === pid && (activeTabType === 'home' || activeView === 'context')

  const activeProjectIds = useMemo(() => {
    const taskById = new Map(tasks.map((t) => [t.id, t]))
    const set = new Set<string>()
    for (const id of openTabTaskIds) {
      const pid = taskById.get(id)?.project_id
      if (pid) set.add(pid)
    }
    for (const id of sessionTaskIds) {
      const pid = taskById.get(id)?.project_id
      if (pid) set.add(pid)
    }
    return set
  }, [tasks, openTabTaskIds, sessionTaskIds])

  const [openProjects, setOpenProjects] = useState<Record<string, boolean>>(() =>
    selectedProjectId ? { [selectedProjectId]: true } : {}
  )

  const [showAll, setShowAll] = useState(false)

  const activeProjects = useMemo(
    () => sortedProjects.filter((p) => activeProjectIds.has(p.id)),
    [sortedProjects, activeProjectIds]
  )
  const hiddenProjects = useMemo(
    () => sortedProjects.filter((p) => !activeProjectIds.has(p.id)),
    [sortedProjects, activeProjectIds]
  )
  const visibleProjects = showAll ? sortedProjects : activeProjects

  const { counts: staleSkillCounts } = useStaleSkillCounts(visibleProjects)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  // `closestCenter` resolves `over` per pointer position. Headers ARE
  // valid drop targets (kind='group'): when pointer is closest to a
  // header, that header becomes `over`, the strategy slides just the
  // header (not the first/last task of the adjacent group), and the
  // visible gap appears at the inter-group boundary — matching user
  // mental model "drop between groups lands between groups".
  const collisionDetection = useCallback<CollisionDetection>((args) => {
    const kind = (args.active.data.current as { kind?: string } | undefined)?.kind
    // A project drag may only land on another project header — filter the
    // droppable set so `over` is never a task row / group header (which would
    // make the drop a silent no-op).
    if (kind === 'project') {
      return closestCenter({
        ...args,
        droppableContainers: args.droppableContainers.filter(
          (c) => (c.data.current as { kind?: string } | undefined)?.kind === 'project'
        )
      })
    }
    return closestCenter(args)
  }, [])

  const handleDragStart = useCallback((event: DragStartEvent) => {
    // Project drags get their own overlay preview, not task-drag bookkeeping.
    // `active.id` is the prefixed sortable id (`project:<id>`) — strip it.
    if ((event.active.data.current as { kind?: string } | undefined)?.kind === 'project') {
      setActiveDragProjectId((event.active.id as string).replace(/^project:/, ''))
      return
    }
    setActiveDragTaskId(event.active.id as string)
  }, [])

  const handleDragCancel = useCallback(() => {
    setActiveDragTaskId(null)
    setActiveDragProjectId(null)
  }, [])

  // Multi-selection — Shift = sibling range, Cmd/Ctrl = toggle individual,
  // plain click = open + clear selection. anchor is the last single/cmd-click
  // target, used as the base point for shift-range expansion. `activeDragTaskId`
  // + `selectedTaskIds` are hoisted above so `childrenByParent` can collapse
  // sub-tasks on drag start.
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null)

  const [editingTaskId, setEditingTaskId] = useState<string | null>(null)
  const handleStartEdit = useCallback((id: string) => setEditingTaskId(id), [])
  const handleCancelEdit = useCallback(() => setEditingTaskId(null), [])

  // Full task lookup (all tasks, not just visible) for cycle detection +
  // orderBy field comparison. Visible-only maps would miss collapsed parents
  // and yield false negatives on cycle check.
  const tasksById = useMemo(() => {
    const m = new Map<string, Task>()
    for (const t of tasks) m.set(t.id, t)
    return m
  }, [tasks])

  const handleCommitEdit = useCallback(
    (id: string, value: string) => {
      setEditingTaskId(null)
      const trimmed = value.trim()
      if (trimmed.length === 0) return
      const current = (tasksById.get(id)?.title ?? '').trim()
      if (trimmed === current) return
      onTaskFieldUpdate?.(id, { title: trimmed })
    },
    [tasksById, onTaskFieldUpdate]
  )

  // Drop into descendant of source = cycle. Walk parent chain from target
  // upward; if it hits source, abort the reparent.
  const wouldCycle = useCallback(
    (sourceId: string, targetId: string): boolean => {
      if (sourceId === targetId) return true
      let cur: string | null | undefined = targetId
      const seen = new Set<string>()
      while (cur && !seen.has(cur)) {
        if (cur === sourceId) return true
        seen.add(cur)
        cur = tasksById.get(cur)?.parent_id ?? null
      }
      return false
    },
    [tasksById]
  )

  // When sorting by a meaningful field (priority/due_date), dropping above or
  // below a sibling with a different value implies the user wants the dragged
  // task to inherit that value — otherwise sort would snap it back to its old
  // position and the drop would feel ignored.
  const inheritOrderByField = useCallback(
    (sourceId: string, targetId: string): void => {
      if (sourceId === targetId) return
      const source = tasksById.get(sourceId)
      const target = tasksById.get(targetId)
      if (!source || !target) return
      if (treeOrderBy === 'priority') {
        if (source.priority !== target.priority) {
          onTaskFieldUpdate?.(sourceId, { priority: target.priority })
        }
      } else if (treeOrderBy === 'due_date') {
        const a = source.due_date ?? null
        const b = target.due_date ?? null
        if (a !== b) onTaskFieldUpdate?.(sourceId, { due_date: b })
      }
      // 'manual' / 'created' / 'title' — no inheritance.
    },
    [treeOrderBy, tasksById, onTaskFieldUpdate]
  )

  // Sibling list of `taskId` in tree render order, scoped to project.
  // Subtask → parent's children; root → all roots across groups (parent=null).
  const getSiblings = useCallback(
    (taskId: string): Task[] => {
      const t = tasksById.get(taskId)
      if (!t) return []
      if (t.parent_id) return childrenByParent.get(t.parent_id) ?? []
      const groups = rootGroupsByProject.get(t.project_id) ?? []
      return groups.flatMap((g) => g.tasks)
    },
    [tasksById, childrenByParent, rootGroupsByProject]
  )

  const handleRowSelectClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>, taskId: string) => {
      const isShift = event.shiftKey
      const isCmd = event.metaKey || event.ctrlKey

      if (isShift && selectionAnchorId && selectionAnchorId !== taskId) {
        event.preventDefault()
        const anchor = tasksById.get(selectionAnchorId)
        const target = tasksById.get(taskId)
        if (!anchor || !target) return
        // Range only when same parent (true siblings). Different-parent shift
        // falls back to "add target" semantics.
        if ((anchor.parent_id ?? null) !== (target.parent_id ?? null)) {
          setSelectedTaskIds((prev) => new Set([...prev, taskId]))
          return
        }
        const siblings = getSiblings(selectionAnchorId)
        const aIdx = siblings.findIndex((s) => s.id === selectionAnchorId)
        const tIdx = siblings.findIndex((s) => s.id === taskId)
        if (aIdx === -1 || tIdx === -1) return
        const [lo, hi] = aIdx < tIdx ? [aIdx, tIdx] : [tIdx, aIdx]
        setSelectedTaskIds(new Set(siblings.slice(lo, hi + 1).map((s) => s.id)))
        // Anchor stays — subsequent shift-clicks pivot from same point.
        return
      }

      if (isCmd) {
        event.preventDefault()
        setSelectedTaskIds((prev) => {
          const next = new Set(prev)
          if (next.has(taskId)) next.delete(taskId)
          else next.add(taskId)
          return next
        })
        setSelectionAnchorId(taskId)
        return
      }

      // Plain click — clear selection, set anchor, open task.
      setSelectedTaskIds(new Set([taskId]))
      setSelectionAnchorId(taskId)
      onTaskClick?.(taskId)
    },
    [selectionAnchorId, tasksById, getSiblings, onTaskClick]
  )

  // Render-order list of moved task ids — the dragged set, in tree visual
  // order. Used so a multi-drag reinserts moved tasks in their original
  // relative order rather than selection iteration order.
  const getMovedIdsInRenderOrder = useCallback(
    (projectId: string, ids: Set<string>): string[] => {
      if (ids.size === 0) return []
      const groups = rootGroupsByProject.get(projectId) ?? []
      const ordered: string[] = []
      const walk = (t: Task) => {
        if (ids.has(t.id) && t.project_id === projectId) ordered.push(t.id)
        const kids = childrenByParent.get(t.id) ?? []
        for (const k of kids) walk(k)
      }
      for (const g of groups) for (const root of g.tasks) walk(root)
      return ordered
    },
    [rootGroupsByProject, childrenByParent]
  )

  // Drop semantics: dragged set always becomes SIBLINGS of the target row.
  // Never children. Multi-drag (selection size > 1, drag handle row is in
  // selection) moves all selected; otherwise just the dragged row.
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDragTaskId(null)
      setActiveDragProjectId(null)
      const { active, over } = event
      if (!over) return
      const activeData = active.data.current as
        | TaskRowDragData
        | GroupDropData
        | ProjectDragData
        | undefined

      // === Project reorder. Drag data kind='project'; ids are prefixed
      // `project:<id>`. arrayMove over the FULL sorted list so every id is
      // submitted — `db:projects:reorder` requires the complete set.
      if (activeData?.kind === 'project') {
        if (active.id === over.id) return
        const oldIndex = sortedProjects.findIndex((p) => `project:${p.id}` === active.id)
        const newIndex = sortedProjects.findIndex((p) => `project:${p.id}` === over.id)
        if (oldIndex === -1 || newIndex === -1) return
        onReorderProjects(arrayMove(sortedProjects, oldIndex, newIndex).map((p) => p.id))
        return
      }

      if (!activeData || activeData.kind !== 'task') return
      const sourceId = active.id as string

      const overData = over.data.current as TaskRowDragData | GroupDropData | undefined
      if (!overData) return

      if (overData.projectId !== activeData.projectId) return

      const groups = rootGroupsByProject.get(activeData.projectId)
      if (!groups) return
      const groupByKey = new Map(groups.map((g) => [g.key, g]))

      // Build the moved set. Multi-drag only when the dragged row is part of a
      // multi-selection; otherwise treat as single (don't sweep up selection
      // unrelated to this drag).
      const isMulti = selectedTaskIds.has(sourceId) && selectedTaskIds.size > 1
      const movedIds = isMulti
        ? getMovedIdsInRenderOrder(activeData.projectId, selectedTaskIds)
        : [sourceId]
      if (movedIds.length === 0) return

      // === Drop on a header. Use arrayMove(active, over) on the flat row
      // order to compute source's new position; source's new group =
      // nearest header above the new position. This matches the pre-slide
      // visual (the verticalListSortingStrategy uses the same arrayMove).
      // For drag DOWN onto a header → source lands at top of header's group.
      // For drag UP onto a header → source lands at end of group ABOVE the
      // header (i.e. above the header in flat order).
      if (overData.kind === 'group') {
        const projectId = activeData.projectId
        const projectGroups = rootGroupsByProject.get(projectId) ?? []
        // Build flat row order (matches render order).
        const flatIds: string[] = []
        const flatIsHeader: boolean[] = []
        const flatGroupOfRow: string[] = []
        const hasCompanions = projectGroups.length > 1
        for (const grp of projectGroups) {
          const showHeader = !grp.isNone || hasCompanions
          if (showHeader) {
            flatIds.push(`header:${projectId}:${grp.key}`)
            flatIsHeader.push(true)
            flatGroupOfRow.push(grp.key)
          }
          const walk = (t: Task): void => {
            flatIds.push(t.id)
            flatIsHeader.push(false)
            flatGroupOfRow.push(grp.key)
            const kids = childrenByParent.get(t.id) ?? []
            for (const k of kids) walk(k)
          }
          for (const t of grp.tasks) walk(t)
        }
        const activeIdx = flatIds.indexOf(sourceId)
        const overIdx = flatIds.indexOf(over.id as string)
        if (activeIdx === -1 || overIdx === -1) return

        // arrayMove(flat, activeIdx, overIdx) — source's new position.
        const newFlatIds = [...flatIds]
        const newFlatIsHeader = [...flatIsHeader]
        const newFlatGroupOfRow = [...flatGroupOfRow]
        const [movedHeaderFlag] = newFlatIsHeader.splice(activeIdx, 1)
        const [movedGroupTag] = newFlatGroupOfRow.splice(activeIdx, 1)
        newFlatIds.splice(activeIdx, 1)
        newFlatIds.splice(overIdx, 0, sourceId)
        newFlatIsHeader.splice(overIdx, 0, movedHeaderFlag)
        newFlatGroupOfRow.splice(overIdx, 0, movedGroupTag)
        const newSourceIdx = newFlatIds.indexOf(sourceId)

        // Walk backward to find source's new group (nearest header above).
        let newGroupKey: string | null = null
        for (let i = newSourceIdx - 1; i >= 0; i--) {
          if (newFlatIsHeader[i]) {
            newGroupKey = newFlatGroupOfRow[i]
            break
          }
        }
        // Fallback for 'none' (single ungrouped bucket, no header) or when
        // source lands above the very first header → keep source's group.
        if (!newGroupKey) newGroupKey = activeData.groupValue

        const newGroup = groupByKey.get(newGroupKey)
        if (!newGroup || newGroup.isTemp) return

        // Drop into the pinned bucket → pin the moved task(s). Status /
        // priority unchanged (pinning is independent). For sources already
        // pinned, toggle would unpin — guard with pinnedSet check.
        if (newGroup.isPinned) {
          const toPin = movedIds.filter((id) => !pinnedSet.has(id))
          if (toPin.length > 0) onSetTasksPinned?.(toPin, true)
          return
        }
        // Source leaving the pinned bucket → unpin (status/priority change
        // applied by the dispatch below).
        if (activeData.groupValue === PINNED_GROUP_KEY) {
          const toUnpin = movedIds.filter((id) => pinnedSet.has(id))
          if (toUnpin.length > 0) onSetTasksPinned?.(toUnpin, false)
        }

        // No-op: same group AND insertion at source's original position.
        if (newGroupKey === activeData.groupValue && newSourceIdx === activeIdx) {
          return
        }

        // Find next root in newGroupKey AFTER source's new idx — used to
        // translate root-only insertion idx into moveTask's status-filtered
        // targetIndex (which counts subtasks too).
        let nextRootId: string | null = null
        for (let i = newSourceIdx + 1; i < newFlatIds.length; i++) {
          if (newFlatIsHeader[i]) break
          if (newFlatGroupOfRow[i] !== newGroupKey) break
          nextRootId = newFlatIds[i]
          break
        }
        const statusFiltered = tasks.filter((t) => {
          if (t.project_id !== projectId) return false
          if (t.id === sourceId) return false
          const key = treeGroupBy === 'status' ? t.status : `p${t.priority}`
          return key === newGroupKey
        })
        const moveIdxStatus = nextRootId
          ? statusFiltered.findIndex((t) => t.id === nextRootId)
          : statusFiltered.length

        const fieldUpdate: Partial<Task> =
          treeGroupBy === 'status'
            ? { status: newGroupKey as Task['status'] }
            : { priority: parseInt(newGroupKey.slice(1), 10) }

        // Root-only newSiblings for bulk reparent + subtask source reparent.
        const movedSet = new Set(movedIds)
        const rootOnlyMoveIdx = (() => {
          let count = 0
          for (let i = 0; i < newSourceIdx; i++) {
            if (newFlatIsHeader[i]) continue
            if (newFlatGroupOfRow[i] !== newGroupKey) continue
            count++
          }
          return count
        })()
        const newSiblings = newGroup.tasks
          .map((t) => t.id)
          .filter((id) => !movedSet.has(id))
        newSiblings.splice(rootOnlyMoveIdx, 0, ...movedIds)

        if (movedIds.length === 1) {
          if (activeData.parentId !== null) {
            onTaskReparent?.(sourceId, null, newSiblings)
            onTaskFieldUpdate?.(sourceId, fieldUpdate)
          } else {
            onTaskMove?.(sourceId, newGroupKey, moveIdxStatus, treeGroupBy)
          }
        } else {
          onTaskBulkReparent?.(movedIds, null, newSiblings)
          onTaskBulkFieldUpdate?.(movedIds, fieldUpdate)
        }
        return
      }

      // === Drop on a task row — moved set becomes siblings of target. ===
      const targetId = over.id as string
      if (movedIds.includes(targetId) && movedIds.length === 1) return
      const target = tasksById.get(targetId)
      if (!target) return
      const targetParent = target.parent_id ?? null

      // Cycle check — none of the moved tasks may be ancestor of targetParent.
      if (targetParent !== null) {
        for (const m of movedIds) {
          if (wouldCycle(m, targetParent)) return
        }
      }

      let siblings: Task[]
      let targetGroupKey: string | null = null
      if (targetParent === null) {
        targetGroupKey = rowGroupValue(target, treeGroupBy, treeGroupPinned, pinnedSet)
        const g = groupByKey.get(targetGroupKey)
        if (!g || g.isTemp) return
        // Drop on a row in the pinned bucket:
        //   - If any moved task isn't pinned yet → pin them (no reorder).
        //     Status/priority preserved (pinning is independent).
        //   - If all moved are already pinned → fall through to standard
        //     same-group reorder (arrayMove on pinned siblings).
        if (g.isPinned) {
          const allPinned = movedIds.every((id) => pinnedSet.has(id))
          if (!allPinned) {
            const toPin = movedIds.filter((id) => !pinnedSet.has(id))
            if (toPin.length > 0) onSetTasksPinned?.(toPin, true)
            return
          }
        }
        // Source leaving the pinned bucket → unpin (status change still
        // applied by the cross-group dispatch below).
        if (
          activeData.groupValue === PINNED_GROUP_KEY &&
          targetGroupKey !== PINNED_GROUP_KEY
        ) {
          const toUnpin = movedIds.filter((id) => pinnedSet.has(id))
          if (toUnpin.length > 0) onSetTasksPinned?.(toUnpin, false)
        }
        siblings = g.tasks
      } else {
        siblings = childrenByParent.get(targetParent) ?? []
      }

      const movedSet = new Set(movedIds)
      const filtered = siblings.filter((s) => !movedSet.has(s.id))
      const filteredTargetIdx = filtered.findIndex((s) => s.id === targetId)
      if (filteredTargetIdx === -1) return
      const sourceOrigIdx = siblings.findIndex((s) => s.id === sourceId)
      const sameGroup = sourceOrigIdx !== -1
      // Drop direction splits by whether source and target share a sibling list:
      //
      //   Same-group: arrayMove(srcIdx, overIdx) semantic. Source ends at
      //   over's pre-shift slot. Direction by source-vs-target original index:
      //     - source above target → insert AFTER target (over slid up under source)
      //     - source below target → insert AT target (over slid down)
      //
      //   Cross-group: pointer position relative to target's current visual
      //   center decides. Above (or exactly at) center → insert BEFORE (source
      //   replaces over's slot). Below center → insert AFTER. This is what
      //   makes "drop just above target's first row" reachable on cross-group
      //   drags, since pre-slide doesn't show a gap above the first row of
      //   the target group via the same-group convention.
      let insertIdx: number
      if (sameGroup) {
        // Same-group: arrayMove(srcIdx, overIdx) semantic. Source ends at
        // over's pre-shift slot in the new array.
        //   srcIdx < overIdx (drag DOWN): over slides up under source →
        //     insert AFTER over in filtered.
        //   srcIdx > overIdx (drag UP): over slides down past source →
        //     insert AT over in filtered.
        const origTargetIdx = siblings.findIndex((s) => s.id === targetId)
        insertIdx = sourceOrigIdx < origTargetIdx ? filteredTargetIdx + 1 : filteredTargetIdx
      } else {
        // Cross-group: pure arrayMove convention so landing matches the
        // pre-slide visual (verticalListSortingStrategy uses arrayMove).
        //   Drag DOWN (source above target in flat): source AFTER target.
        //   Drag UP (source below target in flat): source AT target's slot
        //     (= BEFORE target in flat).
        // "Insert at top of group" semantics route through a header drop
        // (`kind: 'group'` branch) — collision detection picks the header
        // when pointer is in the inter-group gap.
        const flat: string[] = []
        {
          const projectGroups = rootGroupsByProject.get(activeData.projectId) ?? []
          const walk = (t: Task): void => {
            flat.push(t.id)
            const kids = childrenByParent.get(t.id) ?? []
            for (const k of kids) walk(k)
          }
          for (const g of projectGroups) for (const t of g.tasks) walk(t)
        }
        const srcFlatIdx = flat.indexOf(sourceId)
        const tgtFlatIdx = flat.indexOf(targetId)
        const sourceAboveOver =
          srcFlatIdx !== -1 && tgtFlatIdx !== -1 ? srcFlatIdx < tgtFlatIdx : true
        insertIdx = sourceAboveOver ? filteredTargetIdx + 1 : filteredTargetIdx
      }
      const newSiblingIds = [
        ...filtered.slice(0, insertIdx).map((s) => s.id),
        ...movedIds,
        ...filtered.slice(insertIdx).map((s) => s.id)
      ]

      // Single-source no-op guard. Source's new index in the result is exactly
      // `insertIdx` (in the source-removed `filtered` list). If that equals
      // its original slot, the reorder is a no-op.
      if (movedIds.length === 1 && activeData.parentId === targetParent) {
        if (sourceOrigIdx !== -1 && insertIdx === sourceOrigIdx) return
      }

      // Decide: do all moved already share the new parent? (Pure reorder vs reparent.)
      const allSameParent = movedIds.every(
        (id) => (tasksById.get(id)?.parent_id ?? null) === targetParent
      )

      if (movedIds.length === 1) {
        const sameParent = activeData.parentId === targetParent
        if (sameParent) {
          if (
            targetParent === null &&
            targetGroupKey !== null &&
            activeData.groupValue !== targetGroupKey
          ) {
            // `moveTask`'s targetIndex is in the STATUS-filtered task list
            // (subtasks included). `insertIdx` here is in the ROOT-only
            // siblings list. Translate by finding the next root's position
            // in the status-filtered list — or append (statusCount) when
            // inserting past the end.
            const statusFiltered = tasks.filter((t) => {
              if (t.project_id !== activeData.projectId) return false
              if (t.id === sourceId) return false
              const key = treeGroupBy === 'status' ? t.status : `p${t.priority}`
              return key === targetGroupKey
            })
            const nextRootId = insertIdx < filtered.length ? filtered[insertIdx].id : null
            const moveIdx = nextRootId
              ? statusFiltered.findIndex((t) => t.id === nextRootId)
              : statusFiltered.length
            onTaskMove?.(
              sourceId,
              targetGroupKey,
              moveIdx >= 0 ? moveIdx : statusFiltered.length,
              treeGroupBy
            )
            if (!(treeOrderBy === 'priority' && treeGroupBy === 'priority')) {
              inheritOrderByField(sourceId, targetId)
            }
            return
          }
          if (targetGroupKey === PINNED_GROUP_KEY) onPinnedReorder?.(newSiblingIds)
          else onTaskReorder?.(newSiblingIds)
          inheritOrderByField(sourceId, targetId)
          return
        }
        onTaskReparent?.(sourceId, targetParent, newSiblingIds)
        if (targetParent === null && targetGroupKey !== null) {
          const fieldUpdate: Partial<Task> =
            treeGroupBy === 'status'
              ? { status: targetGroupKey as Task['status'] }
              : { priority: parseInt(targetGroupKey.slice(1), 10) }
          onTaskFieldUpdate?.(sourceId, fieldUpdate)
        }
        inheritOrderByField(sourceId, targetId)
        return
      }

      // Multi-drag dispatch.
      if (allSameParent) {
        if (targetGroupKey === PINNED_GROUP_KEY) onPinnedReorder?.(newSiblingIds)
        else onTaskReorder?.(newSiblingIds)
      } else {
        onTaskBulkReparent?.(movedIds, targetParent, newSiblingIds)
      }
      // Inherit groupBy field if becoming root in a group different from any
      // moved task's current value. Apply uniformly to all moved.
      if (targetParent === null && targetGroupKey !== null) {
        const fieldUpdate: Partial<Task> =
          treeGroupBy === 'status'
            ? { status: targetGroupKey as Task['status'] }
            : { priority: parseInt(targetGroupKey.slice(1), 10) }
        onTaskBulkFieldUpdate?.(movedIds, fieldUpdate)
      }
      // orderBy inheritance per moved task — they all snap to target's value.
      if (treeOrderBy === 'priority' || treeOrderBy === 'due_date') {
        const fieldUpdate: Partial<Task> =
          treeOrderBy === 'priority'
            ? { priority: target.priority }
            : { due_date: target.due_date ?? null }
        // Skip when groupBy already wrote the same field.
        const skipOverlap =
          targetParent === null &&
          targetGroupKey !== null &&
          treeOrderBy === 'priority' &&
          treeGroupBy === 'priority'
        if (!skipOverlap) onTaskBulkFieldUpdate?.(movedIds, fieldUpdate)
      }
    },
    [
      childrenByParent,
      rootGroupsByProject,
      onTaskReorder,
      onTaskMove,
      onTaskReparent,
      onTaskBulkReparent,
      onTaskFieldUpdate,
      onTaskBulkFieldUpdate,
      treeGroupBy,
      treeGroupPinned,
      treeOrderBy,
      pinnedSet,
      selectedTaskIds,
      getMovedIdsInRenderOrder,
      tasksById,
      tasks,
      wouldCycle,
      inheritOrderByField,
      sortedProjects,
      onReorderProjects,
      onSetTasksPinned,
      onPinnedReorder
    ]
  )

  // Flatten groups → linear row list interleaving headers and tasks (DFS for
  // sub-tasks). Render order = sortable measurement order. Solo-`none` group
  // skips its header — no companions to disambiguate, so the rows just look
  // like the project's default list.
  const buildRowList = (
    groups: TreeGroup[],
    projectId: string
  ): { rows: RowItem[]; sortableRowIds: string[] } => {
    const rows: RowItem[] = []
    // Ids that participate in `SortableContext`. The temporary group is
    // excluded wholesale — its rows render plain and never slide during a drag.
    const sortableRowIds: string[] = []
    const hasCompanions = groups.length > 1
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi]
      const inDnd = !g.isTemp
      const showHeader = !g.isNone || hasCompanions
      if (showHeader) {
        const headerRowId = `header:${projectId}:${g.key}`
        rows.push({
          kind: 'header',
          rowId: headerRowId,
          group: g,
          padTopClass: gi === 0 ? 'pt-2' : 'pt-4'
        })
        if (inDnd) sortableRowIds.push(headerRowId)
      }
      const walk = (t: Task, depth: number, ancestorFlags: boolean[]): void => {
        rows.push({ kind: 'task', rowId: t.id, task: t, depth, ancestorFlags, inTempGroup: g.isTemp })
        if (inDnd) sortableRowIds.push(t.id)
        const kids = childrenByParent.get(t.id) ?? []
        kids.forEach((k, i) => walk(k, depth + 1, [...ancestorFlags, i < kids.length - 1]))
      }
      g.tasks.forEach((t, i) => walk(t, 1, [i < g.tasks.length - 1]))
    }
    return { rows, sortableRowIds }
  }

  const renderProject = (project: (typeof sortedProjects)[number]) => {
    const projectTasks = tasksByProject.get(project.id) ?? []
    const groups = rootGroupsByProject.get(project.id) ?? []
    const isOpen = openProjects[project.id] ?? false
    const isContextActive = selectedProjectId === project.id && activeView === 'context'
    const isHomeActive =
      selectedProjectId === project.id && activeTabType === 'home' && !isContextActive
    const dragEnabled = Boolean(onTaskReorder) && Boolean(onTaskMove)
    const cols = columnsByProjectId?.get(project.id) ?? null
    // Flat row list: headers + tasks in DFS order. Non-temp header rows
    // participate in the SortableContext so they tween together with
    // surrounding rows, but their drag listeners are disabled — they slide,
    // they don't drag. The temporary group is excluded from `sortableRowIds`.
    const { rows, sortableRowIds } = buildRowList(groups, project.id)
    const flatTaskIds = rows.flatMap((r) => (r.kind === 'task' ? [r.rowId] : []))
    // Compute first/last-in-run flags for each selected task, scanning
    // adjacency in flat render order. Skipped when fewer than 2 selected
    // (single-select uses its own visual treatment).
    const selectionRunInfo = new Map<string, { firstInRun: boolean; lastInRun: boolean }>()
    if (selectedTaskIds.size > 1) {
      for (let i = 0; i < flatTaskIds.length; i++) {
        const id = flatTaskIds[i]
        if (!selectedTaskIds.has(id)) continue
        const prevSelected = i > 0 && selectedTaskIds.has(flatTaskIds[i - 1])
        const nextSelected = i < flatTaskIds.length - 1 && selectedTaskIds.has(flatTaskIds[i + 1])
        selectionRunInfo.set(id, { firstInRun: !prevSelected, lastInRun: !nextSelected })
      }
    }
    const branchCtx: TaskBranchCtx = {
      childrenByParent,
      activeTaskId,
      openTabTaskIds,
      doneTaskIds,
      terminalStates,
      taskProgress,
      columnsByProjectId,
      pinnedSet,
      selectedTaskIds,
      selectedTaskIdArr,
      selectionRunInfo,
      activeDragTaskId,
      treeShowStatus,
      treeShowPriority,
      treeShowWorktree,
      treeCrossOutDone,
      treeGroupBy,
      treeGroupPinned,
      onTaskClick,
      onRowSelectClick: handleRowSelectClick,
      onCloseTab,
      onOpenTaskInBackground,
      taskContextMenuRender,
      taskBulkContextMenuRender,
      dragEnabled,
      editingTaskId,
      onStartEdit: handleStartEdit,
      onCommitEdit: handleCommitEdit,
      onCancelEdit: handleCancelEdit,
      tasksWithChildren,
      collapsedTaskIds: collapsedSet,
      onToggleCollapse: handleToggleCollapse
    }
    // Every non-temp element (group headers, root rows, sub-rows) is a
    // sortable item in one flat list, so `verticalListSortingStrategy` slides
    // them uniformly. Headers are sortable participants with drag DISABLED —
    // they tween with surrounding rows during pre-slide but can't be dragged
    // as a source. Drop on a header routes through `kind: 'group'` → insert at
    // index 0 of that group. The temporary group is excluded entirely: its
    // rows render plain (no `useSortable`) and never drag, drop, or slide.
    return (
      <SortableProject key={project.id} projectId={project.id} disabled={!showAll}>
        {({ setNodeRef, style, listeners }) => (
          <Collapsible.Root
            ref={setNodeRef}
            style={style}
            open={isOpen}
            onOpenChange={(open) => setOpenProjects((s) => ({ ...s, [project.id]: open }))}
            className="rounded-lg overflow-hidden bg-surface-1"
          >
            <div
              {...listeners}
              style={{
                backgroundColor: `color-mix(in oklch, ${project.color} ${projectIsActive(project.id) ? 22 : 10}%, transparent)`
              }}
              className="group/projectrow relative flex h-10 items-center transition-[filter] hover:brightness-125"
            >
              <Collapsible.Trigger
                aria-label={isOpen ? `Collapse ${project.name}` : `Expand ${project.name}`}
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground"
              >
                <ChevronDown
                  className={cn(
                    'size-3.5 transition-transform duration-200',
                    !isOpen && '-rotate-90'
                  )}
                />
              </Collapsible.Trigger>
              <Collapsible.Trigger asChild>
                <button
                  type="button"
                  className="flex flex-1 items-center gap-2 rounded-md py-1.5 text-sm font-semibold min-w-0"
                >
                  <span className="truncate flex-1 text-left">{project.name}</span>
                </button>
              </Collapsible.Trigger>
              <button
                type="button"
                onClick={() => onSelectProject(project.id)}
                aria-label={`Open ${project.name} home`}
                className={cn(
                  'inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-[color,background-color]',
                  isHomeActive
                    ? 'bg-foreground text-background shadow-sm hover:bg-foreground/90'
                    : 'text-muted-foreground/70 hover:text-foreground'
                )}
              >
                <Home className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => {
                  useTabStore.getState().setSelectedProjectId(project.id)
                  useTabStore.getState().setActiveView('context')
                }}
                aria-label={`Context Manager for ${project.name}`}
                className={cn(
                  'relative inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-[color,background-color]',
                  isContextActive
                    ? 'bg-foreground text-background shadow-sm hover:bg-foreground/90'
                    : 'text-muted-foreground/70 hover:text-foreground'
                )}
              >
                <BookOpen className="size-3.5" />
                <ContextStaleDot count={staleSkillCounts.get(project.id) ?? 0} />
              </button>
              <button
                type="button"
                onClick={() => onProjectSettings(project)}
                aria-label={`Settings for ${project.name}`}
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 hover:text-foreground transition-colors mr-0.5"
              >
                <Settings className="size-3.5" />
              </button>
            </div>
            <Collapsible.Content className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
              <div className="flex flex-col pr-2 pt-2 pb-3">
                {projectTasks.length === 0 && groups.length === 0 ? (
                  <span className="text-xs italic text-muted-foreground/60 px-2 py-1">
                    No active tasks
                  </span>
                ) : (
                  <SortableContext
                    items={sortableRowIds}
                    strategy={verticalListSortingStrategy}
                  >
                    {rows.map((r) =>
                      r.kind === 'header' ? (
                        <HeaderRow
                          key={r.rowId}
                          rowId={r.rowId}
                          projectId={project.id}
                          group={r.group}
                          padTopClass={r.padTopClass}
                          cols={cols}
                          treeGroupBy={treeGroupBy}
                          onCreateTemporaryTask={onCreateTemporaryTask}
                        />
                      ) : (
                        <TaskRow
                          key={r.rowId}
                          task={r.task}
                          depth={r.depth}
                          ancestorFlags={r.ancestorFlags}
                          inTempGroup={r.inTempGroup}
                          ctx={branchCtx}
                        />
                      )
                    )}
                  </SortableContext>
                )}
              </div>
            </Collapsible.Content>
          </Collapsible.Root>
        )}
      </SortableProject>
    )
  }

  const openSearch = useDialogStore((s) => s.openSearch)
  const searchShortcut = useShortcutDisplay('search')

  return (
    <div className="@container flex flex-col gap-3 px-1">
      {/* Top icon row — sits in same horizontal hierarchy as project rows so
          rightmost button aligns with project Settings icon by construction.
          pl clears macOS traffic lights (80px total - SidebarGroup p-2 (8) -
          this wrapper's px-1 (4) = 68px). */}
      <div
        className="relative flex items-center h-11 window-drag-region"
        style={{ paddingLeft: 68 }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 -translate-x-1/2 flex items-center gap-1 select-none text-xs font-medium tracking-wide text-foreground @max-[300px]:hidden"
        >
          <span>Slay</span>
          <img src={logo} alt="" draggable={false} className="h-4 w-auto" />
          <span>Zone</span>
        </div>
        <div className="flex items-center ml-auto">
          <Tooltip delayDuration={500}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => openSearch()}
                aria-label="Search"
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors window-no-drag"
              >
                <Search className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {searchShortcut ? `Search (${searchShortcut})` : 'Search'}
            </TooltipContent>
          </Tooltip>
          <TreeDisplaySettings />
          <Tooltip delayDuration={500}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Add project"
                onClick={() => useDialogStore.getState().openCreateProject()}
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors mr-0.5 window-no-drag"
              >
                <Plus className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              Add project
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <SortableContext
          items={visibleProjects.map((p) => `project:${p.id}`)}
          strategy={verticalListSortingStrategy}
        >
          {visibleProjects.map(renderProject)}
        </SortableContext>
        <DragOverlay dropAnimation={null}>
          {activeDragProjectId
            ? (() => {
                const proj = sortedProjects.find((p) => p.id === activeDragProjectId)
                return proj ? <ProjectDragPreview project={proj} /> : null
              })()
            : activeDragTaskId
              ? (() => {
                  const active = tasksById.get(activeDragTaskId)
                  if (!active) return null
                  const isMulti =
                    selectedTaskIds.has(activeDragTaskId) && selectedTaskIds.size > 1
                  const ids = isMulti
                    ? getMovedIdsInRenderOrder(active.project_id, selectedTaskIds)
                    : [activeDragTaskId]
                  const movedTasks = ids
                    .map((id) => tasksById.get(id))
                    .filter((t): t is Task => Boolean(t))
                  return <TaskDragPreview tasks={movedTasks} />
                })()
              : null}
        </DragOverlay>
      </DndContext>
      {hiddenProjects.length > 0 && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="flex items-center justify-center gap-1 px-2 py-2 text-[11px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
        >
          <span>{showAll ? 'Hide inactive' : 'Show all projects'}</span>
          <ChevronDown className={cn('size-3 transition-transform', showAll && 'rotate-180')} />
        </button>
      )}
    </div>
  )
}
