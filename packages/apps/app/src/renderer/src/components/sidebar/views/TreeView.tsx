import { useCallback, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { BookOpen, ChevronDown, Clock, GitBranch, Home, Pin, Plus, Power, Search, Settings, X } from 'lucide-react'
import * as Collapsible from '@radix-ui/react-collapsible'
import {
  DndContext,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { cn, TerminalProgressDot, PriorityIcon, getColumnStatusStyle, Tooltip, TooltipContent, TooltipTrigger, useShortcutDisplay } from '@slayzone/ui'
import { type Task } from '@slayzone/task/shared'
import { useDialogStore, useTabStore } from '@slayzone/settings'
import { PRIORITY_LABELS } from '@slayzone/tasks'
import { groupTreeRows, orderTreeRows, type TreeGroup } from './treeGrouping'
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
  treeShowStatus: boolean
  treeShowPriority: boolean
  treeShowWorktree: boolean
  treeCrossOutDone: boolean
  treeGroupBy: 'status' | 'priority'
  onTaskClick?: (taskId: string) => void
  onCloseTab?: (taskId: string) => void
  onOpenTaskInBackground?: (taskId: string) => void
  taskContextMenuRender?: SidebarViewContext['taskContextMenuRender']
  dragEnabled: boolean
}

function rowGroupValue(task: Task, groupBy: 'status' | 'priority'): string {
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
  const draggable = ctx.dragEnabled && !task.is_temporary
  const dragData: TaskRowDragData = {
    kind: 'task',
    projectId: task.project_id,
    groupValue: rowGroupValue(task, ctx.treeGroupBy),
    parentId: task.parent_id ?? null,
  }
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: dragData,
    disabled: !draggable,
  })
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }

  const isActive = ctx.activeTaskId === task.id
  const isOpenTab = ctx.openTabTaskIds.has(task.id)
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
      onClick={() => ctx.onTaskClick?.(task.id)}
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
          'relative flex flex-1 items-center gap-2 rounded-md px-1.5 py-1 min-w-0 transition-colors',
          isActive
            ? 'bg-white/10 text-foreground'
            : isOpenTab
              ? 'text-foreground hover:bg-accent/40'
              : 'text-muted-foreground/45 hover:bg-accent/40 hover:text-accent-foreground'
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
        <span
          className={cn(
            'truncate flex-1',
            ctx.treeCrossOutDone && isDone && 'line-through text-muted-foreground/60'
          )}
        >
          {task.title || 'Untitled'}
        </span>
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
      {children.length > 0 && (
        <SortableContext items={children.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          {children.map((c, i) => (
            <TaskBranch
              key={c.id}
              task={c}
              depth={depth + 1}
              ancestorFlags={[...ancestorFlags, i < children.length - 1]}
              ctx={ctx}
            />
          ))}
        </SortableContext>
      )}
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
      })
      result.set(pid, groups)
    }
    return result
  }, [rootTasksByProject, columnsByProjectId, treeGroupBy, treeShowEmptyGroups, statusFilter, treeGroupTemporary])

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

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (!over) return
    const activeData = active.data.current as TaskRowDragData | undefined
    if (!activeData || activeData.kind !== 'task') return
    const overData = over.data.current as TaskRowDragData | GroupDropData | undefined
    if (!overData) return

    // Cross-project blocked.
    if (overData.projectId !== activeData.projectId) return

    // Subtask: only sibling reorder, no reparent. Subtasks stay nested under
    // parent regardless of treeGroupBy, so cross-group check doesn't apply.
    if (activeData.parentId) {
      if (overData.kind !== 'task') return
      if (overData.parentId !== activeData.parentId) return
      if (active.id === over.id) return
      const siblings = childrenByParent.get(activeData.parentId) ?? []
      const oldIdx = siblings.findIndex((s) => s.id === active.id)
      const newIdx = siblings.findIndex((s) => s.id === over.id)
      if (oldIdx === -1 || newIdx === -1 || oldIdx === newIdx) return
      const reordered = arrayMove(siblings, oldIdx, newIdx)
      onTaskReorder?.(reordered.map((t) => t.id))
      return
    }

    // Root task drag.
    const groups = rootGroupsByProject.get(activeData.projectId)
    if (!groups) return
    const groupByKey = new Map(groups.map((g) => [g.key, g]))

    // Block drops into the temp group — temp tasks aren't draggable + drop
    // target there has no valid status/priority semantic.
    if (overData.kind === 'group' && groupByKey.get(overData.groupValue)?.isTemp) return

    if (overData.kind === 'group') {
      const destValue = overData.groupValue
      if (destValue === activeData.groupValue) return
      const destGroup = groupByKey.get(destValue)
      const destLen = destGroup?.tasks.length ?? 0
      onTaskMove?.(active.id as string, destValue, destLen, treeGroupBy)
      return
    }

    // overData is a task. Block dropping a root onto a subtask (would reparent).
    if (overData.parentId) return

    if (overData.groupValue === activeData.groupValue) {
      // Same-group reorder.
      const group = groupByKey.get(activeData.groupValue)
      if (!group) return
      const oldIdx = group.tasks.findIndex((t) => t.id === active.id)
      const newIdx = group.tasks.findIndex((t) => t.id === over.id)
      if (oldIdx === -1 || newIdx === -1 || oldIdx === newIdx) return
      const reordered = arrayMove(group.tasks, oldIdx, newIdx)
      onTaskReorder?.(reordered.map((t) => t.id))
    } else {
      // Cross-group drag onto a task — move source into target's group at target's index.
      const destGroup = groupByKey.get(overData.groupValue)
      if (!destGroup || destGroup.isTemp) return
      const newIdx = destGroup.tasks.findIndex((t) => t.id === over.id)
      if (newIdx === -1) return
      onTaskMove?.(active.id as string, overData.groupValue, newIdx, treeGroupBy)
    }
  }, [childrenByParent, rootGroupsByProject, onTaskReorder, onTaskMove, treeGroupBy])

  const renderGroupAddButton = (
    group: TreeGroup,
    projectId: string,
    label: string
  ): ReactNode => {
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
      if (g.isTemp) {
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
          <SortableContext items={g.tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
            {g.tasks.map((task, i) => (
              <TaskBranch
                key={task.id}
                task={task}
                depth={1}
                ancestorFlags={[i < g.tasks.length - 1]}
                ctx={branchCtx}
              />
            ))}
          </SortableContext>
        </>
      )
      // Temp tasks aren't draggable + their group has no valid drop semantic,
      // so skip the droppable wrapper.
      if (g.isTemp) return <div key={g.key}>{groupBody}</div>
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
    const branchCtx: TaskBranchCtx = {
      childrenByParent,
      activeTaskId,
      openTabTaskIds,
      doneTaskIds,
      terminalStates,
      taskProgress,
      columnsByProjectId,
      pinnedSet,
      treeShowStatus,
      treeShowPriority,
      treeShowWorktree,
      treeCrossOutDone,
      treeGroupBy,
      onTaskClick,
      onCloseTab,
      onOpenTaskInBackground,
      taskContextMenuRender,
      dragEnabled,
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
              renderTreeGroups(groups, project.id, branchCtx)
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
      <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragEnd={handleDragEnd}>
        {visibleProjects.map(renderProject)}
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
