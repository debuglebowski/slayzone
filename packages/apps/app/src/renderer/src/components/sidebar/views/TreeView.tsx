import { useCallback, useMemo, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { BookOpen, ChevronDown, Clock, GitBranch, Home, Pin, Plus, Power, Search, Settings, X } from 'lucide-react'
import * as Collapsible from '@radix-ui/react-collapsible'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { cn, TerminalProgressDot, PriorityIcon, getColumnStatusStyle, Tooltip, TooltipContent, TooltipTrigger, useShortcutDisplay } from '@slayzone/ui'
import { type Task } from '@slayzone/task/shared'
import { useDialogStore, useTabStore } from '@slayzone/settings'
import { PRIORITY_LABELS } from '@slayzone/tasks'
import { groupTreeRows, orderTreeRows, PINNED_GROUP_KEY, type TreeGroup } from './treeGrouping'
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

function TreeGuides({ depth, ancestorFlags }: { depth: number; ancestorFlags: boolean[] }): ReactNode {
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
      {ancestorFlags.slice(0, -1).map((flag, a) =>
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
  treeGroupBy: 'status' | 'priority'
  treeGroupPinned: boolean
  onTaskClick?: (taskId: string) => void
  onRowSelectClick: (event: ReactMouseEvent<HTMLButtonElement>, taskId: string) => void
  onCloseTab?: (taskId: string) => void
  onOpenTaskInBackground?: (taskId: string) => void
  taskContextMenuRender?: SidebarViewContext['taskContextMenuRender']
  dragEnabled: boolean
  editingTaskId: string | null
  onStartEdit: (taskId: string) => void
  onCommitEdit: (taskId: string, value: string) => void
  onCancelEdit: () => void
}

function RenameInput({
  initialValue,
  onCommit,
  onCancel,
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
  groupBy: 'status' | 'priority',
  groupPinned: boolean,
  pinnedSet: Set<string>
): string {
  if (groupPinned && pinnedSet.has(task.id)) return PINNED_GROUP_KEY
  if (groupBy === 'priority') return `p${typeof task.priority === 'number' ? task.priority : 5}`
  return task.status
}

function TaskRow({
  task,
  depth,
  ancestorFlags,
  ctx,
}: {
  task: Task
  depth: number
  ancestorFlags: boolean[]
  ctx: TaskBranchCtx
}): ReactNode {
  const isEditing = ctx.editingTaskId === task.id
  const draggable = ctx.dragEnabled && !task.is_temporary && !isEditing
  const dragData: TaskRowDragData = {
    kind: 'task',
    projectId: task.project_id,
    groupValue: rowGroupValue(task, ctx.treeGroupBy, ctx.treeGroupPinned, ctx.pinnedSet),
    parentId: task.parent_id ?? null,
  }
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: dragData,
    disabled: !draggable,
  })
  // Multi-drag: when the dragged row is part of a multi-selection, every
  // selected row should appear to "lift" together. Hide all selected rows
  // (not just the dragged one) so the floating +N preview is the only
  // visible representation of the moving set.
  const isMultiDragSourceActive =
    ctx.activeDragTaskId !== null
    && ctx.selectedTaskIds.has(ctx.activeDragTaskId)
    && ctx.selectedTaskIds.size > 1
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
    pointerEvents: effectivelyHidden ? 'none' : undefined,
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
      onMouseDown={(e) => { if (e.button === 1) e.preventDefault() }}
      style={{ ...style, paddingLeft: tgPaddingLeft(depth), minHeight: TG_ROW_HEIGHT }}
      className="group/treerow relative flex w-full items-center pr-1 text-sm text-left touch-none"
      {...attributes}
      {...listeners}
    >
      <TreeGuides depth={depth} ancestorFlags={ancestorFlags} />
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
            Attention
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

  return (
    <div>
      {ctx.taskContextMenuRender ? ctx.taskContextMenuRender(task, button) : button}
    </div>
  )
}

function TaskBranch({
  task,
  depth,
  ancestorFlags,
  ctx,
}: {
  task: Task
  depth: number
  ancestorFlags: boolean[]
  ctx: TaskBranchCtx
}): ReactNode {
  const children = ctx.childrenByParent.get(task.id) ?? []
  return (
    <div>
      <TaskRow task={task} depth={depth} ancestorFlags={ancestorFlags} ctx={ctx} />
      {children.map((c, i) => (
        <TaskBranch
          key={c.id}
          task={c}
          depth={depth + 1}
          ancestorFlags={[...ancestorFlags, i < children.length - 1]}
          ctx={ctx}
        />
      ))}
    </div>
  )
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

function StatusGroupDroppable({
  projectId,
  groupValue,
  children,
}: {
  projectId: string
  groupValue: string
  children: ReactNode
}): ReactNode {
  const { setNodeRef, isOver } = useDroppable({
    id: `group:${projectId}:${groupValue}`,
    data: { kind: 'group', projectId, groupValue } satisfies GroupDropData,
  })
  return (
    <div
      ref={setNodeRef}
      data-testid="tree-status-group"
      data-project-id={projectId}
      data-status={groupValue}
      className={cn(
        'rounded-md transition-colors',
        isOver && 'bg-accent/15 ring-1 ring-accent/30'
      )}
    >
      {children}
    </div>
  )
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
}: SidebarViewContext) {
  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
    [projects]
  )

  const treeStatusFilter = useTabStore((s) => s.treeStatusFilter)
  const statusFilter = useMemo(() => new Set(treeStatusFilter), [treeStatusFilter])
  const treeShowStatus = useTabStore((s) => s.treeShowStatus)
  const treeShowPriority = useTabStore((s) => s.treeShowPriority)
  const treeShowSubtasks = useTabStore((s) => s.treeShowSubtasks)
  const treeIncludeAllSubtasks = useTabStore((s) => s.treeShowAllSubtasks)
  const treeIncludeAllUndoneSubtasks = useTabStore((s) => s.treeShowAllUndoneSubtasks)
  const treeCrossOutDone = useTabStore((s) => s.treeCrossOutDone)
  const treeShowOnlyActive = useTabStore((s) => s.treeShowOnlyActive)
  const treeShowTemporary = useTabStore((s) => s.treeShowTemporary)
  const treeShowWorktree = useTabStore((s) => s.treeShowWorktree)
  const treePinnedTaskIds = useTabStore((s) => s.treePinnedTaskIds)
  const pinnedSet = useMemo(() => new Set(treePinnedTaskIds), [treePinnedTaskIds])
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
      if (!treeShowTemporary && t.is_temporary) return false
      if (treeShowOnlyActive) {
        if (!sessionTaskIds.has(t.id) && !pinnedSet.has(t.id)) return false
      }
      // Temp tasks ignore the open-tab bypass: a done temp scratch session
      // with a lingering tab is stale, not active work.
      return (
        statusFilter.has(t.status) ||
        pinnedSet.has(t.id) ||
        (!t.is_temporary && openTabTaskIds.has(t.id)) ||
        sessionTaskIds.has(t.id)
      )
    },
    [statusFilter, pinnedSet, openTabTaskIds, sessionTaskIds, treeShowOnlyActive, treeShowTemporary]
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

    if (treeShowSubtasks && (treeIncludeAllSubtasks || treeIncludeAllUndoneSubtasks)) {
      const excludeDone = !treeIncludeAllSubtasks && treeIncludeAllUndoneSubtasks
      const childrenOf = new Map<string, Task[]>()
      for (const t of tasks) {
        if (!t.parent_id) continue
        const list = childrenOf.get(t.parent_id) ?? []
        list.push(t)
        childrenOf.set(t.parent_id, list)
      }
      for (const t of tasks) {
        if (t.parent_id) continue
        if (!passesFilter(t)) continue
        const stack: Task[] = [t]
        while (stack.length > 0) {
          const cur = stack.pop()!
          if (set.has(cur.id) || cur.archived_at) continue
          // Root passes filter, so include regardless of done. Descendants only
          // gated by excludeDone — keeps a matching root visible even if done.
          if (excludeDone && cur.id !== t.id && doneTaskIds?.has(cur.id)) continue
          set.add(cur.id)
          const kids = childrenOf.get(cur.id)
          if (kids) for (const k of kids) stack.push(k)
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
  }, [tasks, passesFilter, treeShowSubtasks, treeIncludeAllSubtasks, treeIncludeAllUndoneSubtasks, doneTaskIds])

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
  const childrenByParent = useMemo(() => {
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
        pinnedIds: pinnedSet,
      })
      result.set(pid, groups)
    }
    return result
  }, [rootTasksByProject, columnsByProjectId, treeGroupBy, treeShowEmptyGroups, statusFilter, treeGroupTemporary, treeGroupPinned, pinnedSet])

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

  // Track active drag for DragOverlay rendering. Storing just the id keeps
  // state small; the task is looked up at render time.
  const [activeDragTaskId, setActiveDragTaskId] = useState<string | null>(null)

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragTaskId(event.active.id as string)
  }, [])

  const handleDragCancel = useCallback(() => {
    setActiveDragTaskId(null)
  }, [])

  // Multi-selection — Shift = sibling range, Cmd/Ctrl = toggle individual,
  // plain click = open + clear selection. anchor is the last single/cmd-click
  // target, used as the base point for shift-range expansion.
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(() => new Set())
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

  const handleCommitEdit = useCallback((id: string, value: string) => {
    setEditingTaskId(null)
    const trimmed = value.trim()
    if (trimmed.length === 0) return
    const current = (tasksById.get(id)?.title ?? '').trim()
    if (trimmed === current) return
    onTaskFieldUpdate?.(id, { title: trimmed })
  }, [tasksById, onTaskFieldUpdate])

  // Drop into descendant of source = cycle. Walk parent chain from target
  // upward; if it hits source, abort the reparent.
  const wouldCycle = useCallback((sourceId: string, targetId: string): boolean => {
    if (sourceId === targetId) return true
    let cur: string | null | undefined = targetId
    const seen = new Set<string>()
    while (cur && !seen.has(cur)) {
      if (cur === sourceId) return true
      seen.add(cur)
      cur = tasksById.get(cur)?.parent_id ?? null
    }
    return false
  }, [tasksById])

  // When sorting by a meaningful field (priority/due_date), dropping above or
  // below a sibling with a different value implies the user wants the dragged
  // task to inherit that value — otherwise sort would snap it back to its old
  // position and the drop would feel ignored.
  const inheritOrderByField = useCallback((sourceId: string, targetId: string): void => {
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
  }, [treeOrderBy, tasksById, onTaskFieldUpdate])

  // Sibling list of `taskId` in tree render order, scoped to project.
  // Subtask → parent's children; root → all roots across groups (parent=null).
  const getSiblings = useCallback((taskId: string): Task[] => {
    const t = tasksById.get(taskId)
    if (!t) return []
    if (t.parent_id) return childrenByParent.get(t.parent_id) ?? []
    const groups = rootGroupsByProject.get(t.project_id) ?? []
    return groups.flatMap((g) => g.tasks)
  }, [tasksById, childrenByParent, rootGroupsByProject])

  const handleRowSelectClick = useCallback((event: ReactMouseEvent<HTMLButtonElement>, taskId: string) => {
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
  }, [selectionAnchorId, tasksById, getSiblings, onTaskClick])

  // Render-order list of moved task ids — the dragged set, in tree visual
  // order. Used so a multi-drag reinserts moved tasks in their original
  // relative order rather than selection iteration order.
  const getMovedIdsInRenderOrder = useCallback((projectId: string, ids: Set<string>): string[] => {
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
  }, [rootGroupsByProject, childrenByParent])

  // Drop semantics: dragged set always becomes SIBLINGS of the target row.
  // Never children. Multi-drag (selection size > 1, drag handle row is in
  // selection) moves all selected; otherwise just the dragged row.
  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setActiveDragTaskId(null)
    const { active, over } = event
    if (!over) return
    const activeData = active.data.current as TaskRowDragData | undefined
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

    // === Drop on a group header — all moved become roots in that group. ===
    if (overData.kind === 'group') {
      const g = groupByKey.get(overData.groupValue)
      if (!g || g.isTemp || g.isPinned) return
      // Skip when nothing to do (single root already in same group, no-op).
      if (
        movedIds.length === 1 &&
        activeData.parentId === null &&
        overData.groupValue === activeData.groupValue
      ) {
        return
      }
      const movedSet = new Set(movedIds)
      const newSiblings = [
        ...g.tasks.map((t) => t.id).filter((id) => !movedSet.has(id)),
        ...movedIds,
      ]
      const fieldUpdate: Partial<Task> = treeGroupBy === 'status'
        ? { status: overData.groupValue as Task['status'] }
        : { priority: parseInt(overData.groupValue.slice(1), 10) }
      if (movedIds.length === 1) {
        if (activeData.parentId !== null) {
          onTaskReparent?.(sourceId, null, newSiblings)
          onTaskFieldUpdate?.(sourceId, fieldUpdate)
        } else {
          onTaskMove?.(sourceId, overData.groupValue, g.tasks.length, treeGroupBy)
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

    // Pointer-Y vs target mid → above/below target.
    const startY =
      event.activatorEvent && 'clientY' in event.activatorEvent
        ? (event.activatorEvent as { clientY: number }).clientY
        : 0
    const pointerY = startY + event.delta.y
    const overRect = over.rect
    const insertBelow = pointerY > overRect.top + overRect.height / 2

    let siblings: Task[]
    let targetGroupKey: string | null = null
    if (targetParent === null) {
      targetGroupKey = rowGroupValue(target, treeGroupBy, treeGroupPinned, pinnedSet)
      const g = groupByKey.get(targetGroupKey)
      if (!g || g.isTemp || g.isPinned) return
      siblings = g.tasks
    } else {
      siblings = childrenByParent.get(targetParent) ?? []
    }

    // Strip moved AND target out of siblings, find target's slot in the
    // stripped list, then re-insert moved (in render order) at insert slot.
    const movedSet = new Set(movedIds)
    const filtered = siblings.filter((s) => !movedSet.has(s.id))
    const targetIdx = filtered.findIndex((s) => s.id === targetId)
    if (targetIdx === -1) return
    const insertIdx = insertBelow ? targetIdx + 1 : targetIdx
    const newSiblingIds = [
      ...filtered.slice(0, insertIdx).map((s) => s.id),
      ...movedIds,
      ...filtered.slice(insertIdx).map((s) => s.id),
    ]

    // Single-source no-op guard (reorder onto own current slot).
    if (movedIds.length === 1) {
      const sameParent = activeData.parentId === targetParent
      if (sameParent) {
        const oldIdx = siblings.findIndex((s) => s.id === sourceId)
        if (oldIdx !== -1) {
          const adjusted = oldIdx < insertIdx ? insertIdx - 1 : insertIdx
          if (adjusted === oldIdx) return
        }
      }
    }

    // Decide: do all moved already share the new parent? (Pure reorder vs reparent.)
    const allSameParent = movedIds.every((id) => (tasksById.get(id)?.parent_id ?? null) === targetParent)

    if (movedIds.length === 1) {
      const sameParent = activeData.parentId === targetParent
      if (sameParent) {
        if (targetParent === null && targetGroupKey !== null && activeData.groupValue !== targetGroupKey) {
          onTaskMove?.(sourceId, targetGroupKey, insertIdx, treeGroupBy)
          if (!(treeOrderBy === 'priority' && treeGroupBy === 'priority')) {
            inheritOrderByField(sourceId, targetId)
          }
          return
        }
        onTaskReorder?.(newSiblingIds)
        inheritOrderByField(sourceId, targetId)
        return
      }
      onTaskReparent?.(sourceId, targetParent, newSiblingIds)
      if (targetParent === null && targetGroupKey !== null) {
        const fieldUpdate: Partial<Task> = treeGroupBy === 'status'
          ? { status: targetGroupKey as Task['status'] }
          : { priority: parseInt(targetGroupKey.slice(1), 10) }
        onTaskFieldUpdate?.(sourceId, fieldUpdate)
      }
      inheritOrderByField(sourceId, targetId)
      return
    }

    // Multi-drag dispatch.
    if (allSameParent) {
      onTaskReorder?.(newSiblingIds)
    } else {
      onTaskBulkReparent?.(movedIds, targetParent, newSiblingIds)
    }
    // Inherit groupBy field if becoming root in a group different from any
    // moved task's current value. Apply uniformly to all moved.
    if (targetParent === null && targetGroupKey !== null) {
      const fieldUpdate: Partial<Task> = treeGroupBy === 'status'
        ? { status: targetGroupKey as Task['status'] }
        : { priority: parseInt(targetGroupKey.slice(1), 10) }
      onTaskBulkFieldUpdate?.(movedIds, fieldUpdate)
    }
    // orderBy inheritance per moved task — they all snap to target's value.
    if (treeOrderBy === 'priority' || treeOrderBy === 'due_date') {
      const fieldUpdate: Partial<Task> = treeOrderBy === 'priority'
        ? { priority: target.priority }
        : { due_date: target.due_date ?? null }
      // Skip when groupBy already wrote the same field.
      const skipOverlap = targetParent === null && targetGroupKey !== null
        && ((treeOrderBy === 'priority' && treeGroupBy === 'priority'))
      if (!skipOverlap) onTaskBulkFieldUpdate?.(movedIds, fieldUpdate)
    }
  }, [
    childrenByParent, rootGroupsByProject, onTaskReorder, onTaskMove, onTaskReparent,
    onTaskBulkReparent, onTaskFieldUpdate, onTaskBulkFieldUpdate,
    treeGroupBy, treeGroupPinned, treeOrderBy, pinnedSet,
    selectedTaskIds, getMovedIdsInRenderOrder,
    tasksById, wouldCycle, inheritOrderByField,
  ])

  const renderGroupAddButton = (
    group: TreeGroup,
    projectId: string,
    label: string
  ): ReactNode => {
    if (group.isPinned) return null
    if (group.isTemp && !onCreateTemporaryTask) return null
    return (
      <button
        type="button"
        onClick={() => {
          if (group.isTemp) {
            onCreateTemporaryTask?.(projectId)
            return
          }
          if (treeGroupBy === 'priority') {
            const prio = parseInt(group.key.slice(1), 10)
            useDialogStore.getState().openCreateTask({ projectId, priority: Number.isFinite(prio) ? prio : undefined })
            return
          }
          useDialogStore.getState().openCreateTask({ projectId, status: group.key as Task['status'] })
        }}
        aria-label={`New ${group.isTemp ? 'temporary ' : ''}task in ${label}`}
        className="ml-auto inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 hover:bg-accent/40 hover:text-foreground transition-colors"
      >
        <Plus className="size-3" />
      </button>
    )
  }

  const renderTreeGroups = (
    groups: TreeGroup[],
    projectId: string,
    branchCtx: TaskBranchCtx
  ): ReactNode => {
    const cols = columnsByProjectId?.get(projectId) ?? null
    return groups.map((g) => {
      let label: string
      let Icon: typeof Clock | null = null
      let iconClass: string | undefined
      if (g.isPinned) {
        label = 'Pinned'
        Icon = Pin
        iconClass = 'text-muted-foreground/60 -rotate-45 fill-current'
      } else if (g.isTemp) {
        label = 'Temporary'
        Icon = Clock
        iconClass = 'text-muted-foreground/60'
      } else if (treeGroupBy === 'priority') {
        const prio = parseInt(g.key.slice(1), 10)
        label = PRIORITY_LABELS[prio] ?? g.key
      } else {
        const style = getColumnStatusStyle(g.key, cols)
        label = style?.label ?? g.key
        Icon = style?.icon ?? null
        iconClass = style?.iconClass
      }

      const groupBody = (
        <>
          <div className="flex items-center gap-1.5 px-2 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">
            {Icon && <Icon className={cn('size-3', iconClass)} />}
            <span>{label}</span>
            {renderGroupAddButton(g, projectId, label)}
          </div>
          {g.tasks.map((task, i) => (
            <TaskBranch
              key={task.id}
              task={task}
              depth={1}
              ancestorFlags={[i < g.tasks.length - 1]}
              ctx={branchCtx}
            />
          ))}
        </>
      )
      // Temp/pinned groups have no valid drop semantic, so skip droppable wrapper.
      if (g.isTemp || g.isPinned) return <div key={g.key}>{groupBody}</div>
      return (
        <StatusGroupDroppable key={g.key} projectId={projectId} groupValue={g.key}>
          {groupBody}
        </StatusGroupDroppable>
      )
    })
  }

  const renderProject = (project: typeof sortedProjects[number]) => {
    const projectTasks = tasksByProject.get(project.id) ?? []
    const groups = rootGroupsByProject.get(project.id) ?? []
    const isOpen = openProjects[project.id] ?? false
    const isContextActive = selectedProjectId === project.id && activeView === 'context'
    const isHomeActive =
      selectedProjectId === project.id && activeTabType === 'home' && !isContextActive
    const dragEnabled = Boolean(onTaskReorder) && Boolean(onTaskMove)
    // Flat list of all visible task IDs in render order (group → root →
    // descendants pre-order). Single SortableContext over the whole tree so
    // verticalListSortingStrategy animates siblings AND descendants when
    // dragging across the hierarchy. handleDragEnd still enforces drop semantics.
    const flatTaskIds: string[] = (() => {
      const ids: string[] = []
      const walk = (t: Task) => {
        ids.push(t.id)
        const kids = childrenByParent.get(t.id) ?? []
        for (const k of kids) walk(k)
      }
      for (const g of groups) {
        for (const root of g.tasks) walk(root)
      }
      return ids
    })()
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
      dragEnabled,
      editingTaskId,
      onStartEdit: handleStartEdit,
      onCommitEdit: handleCommitEdit,
      onCancelEdit: handleCancelEdit,
    }
    return (
      <Collapsible.Root
        key={project.id}
        open={isOpen}
        onOpenChange={(open) => setOpenProjects((s) => ({ ...s, [project.id]: open }))}
        className="rounded-lg overflow-hidden bg-surface-1"
      >
        <div
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
          <div className="flex flex-col pr-2 pt-2 pb-2">
            {projectTasks.length === 0 && groups.length === 0 ? (
              <span className="text-xs italic text-muted-foreground/60 px-2 py-1">
                No active tasks
              </span>
            ) : (
              <SortableContext items={flatTaskIds} strategy={verticalListSortingStrategy}>
                {renderTreeGroups(groups, project.id, branchCtx)}
              </SortableContext>
            )}
          </div>
        </Collapsible.Content>
      </Collapsible.Root>
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
      <div className="relative flex items-center h-11" style={{ paddingLeft: 68 }}>
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
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
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
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors mr-0.5"
              >
                <Plus className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">Add project</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        {visibleProjects.map(renderProject)}
        <DragOverlay dropAnimation={null}>
          {activeDragTaskId
            ? (() => {
                const active = tasksById.get(activeDragTaskId)
                if (!active) return null
                const isMulti = selectedTaskIds.has(activeDragTaskId) && selectedTaskIds.size > 1
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
