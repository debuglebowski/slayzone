import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, GitBranch, Home, Pin, Settings } from 'lucide-react'
import * as Collapsible from '@radix-ui/react-collapsible'
import { cn, TerminalProgressDot, PriorityIcon, getColumnStatusStyle } from '@slayzone/ui'
import { type Task } from '@slayzone/task/shared'
import { useTabStore } from '@slayzone/settings'
import { useFilterStateMap, sortTasks, getViewConfig } from '@slayzone/tasks'
import { useActiveSessionTaskIds } from '@/components/agent-status/useIdleTasks'
import type { SidebarViewContext } from './types'

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

export function TreeView({
  projects,
  tasks,
  selectedProjectId,
  onSelectProject,
  onProjectSettings,
  onTaskClick,
  taskContextMenuRender,
  terminalStates,
  taskProgress,
  doneTaskIds,
  columnsByProjectId,
}: SidebarViewContext) {
  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
    [projects]
  )

  const treeStatusFilter = useTabStore((s) => s.treeStatusFilter)
  const statusFilter = useMemo(() => new Set(treeStatusFilter), [treeStatusFilter])
  const treeShowStatus = useTabStore((s) => s.treeShowStatus)
  const treeShowPriority = useTabStore((s) => s.treeShowPriority)
  const treeSubtaskMode = useTabStore((s) => s.treeSubtaskMode)
  const treeShowSubtasks = treeSubtaskMode !== 'hide'
  const treeIncludeAllSubtasks = treeSubtaskMode === 'all'
  const treeCrossOutDone = useTabStore((s) => s.treeCrossOutDone)
  const treeShowWorktree = useTabStore((s) => s.treeShowWorktree)
  const treePinnedTaskIds = useTabStore((s) => s.treePinnedTaskIds)
  const pinnedSet = useMemo(() => new Set(treePinnedTaskIds), [treePinnedTaskIds])
  const passesFilter = useCallback(
    (t: Task) =>
      !t.archived_at && (statusFilter.has(t.status) || pinnedSet.has(t.id) || t.is_temporary),
    [statusFilter, pinnedSet]
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

    if (treeShowSubtasks && treeIncludeAllSubtasks) {
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
  }, [tasks, passesFilter, treeShowSubtasks, treeIncludeAllSubtasks])

  // Per-project filters (mirrors kanban). Live-updates when user changes
  // sortBy / groupBy in the kanban filter bar.
  const projectIds = useMemo(() => projects.map((p) => p.id), [projects])
  const filtersByProject = useFilterStateMap(projectIds)

  // Visible tasks bucketed and sorted per project using each project's
  // own kanban sort preference.
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
      const f = filtersByProject[pid]
      const sortBy = f ? getViewConfig(f).sortBy : 'manual'
      sorted.set(pid, sortTasks(arr, sortBy))
    }
    return sorted
  }, [tasks, visibleTaskIds, filtersByProject])

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

  const activeTaskId = useTabStore((s) => {
    const tab = s.tabs[s.activeTabIndex]
    return tab?.type === 'task' ? tab.taskId : null
  })
  const activeTabType = useTabStore((s) => s.tabs[s.activeTabIndex]?.type)
  const activeView = useTabStore((s) => s.activeView)
  const projectIsActive = (pid: string) =>
    selectedProjectId === pid && (activeTabType === 'home' || activeView === 'context')

  const tabs = useTabStore((s) => s.tabs)
  const openTabTaskIds = useMemo(() => {
    const ids = new Set<string>()
    for (const t of tabs) if (t.type === 'task') ids.add(t.taskId)
    return ids
  }, [tabs])

  const sessionTaskIds = useActiveSessionTaskIds()

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

  const renderTask = (task: Task, depth: number, ancestorFlags: boolean[]): ReactNode => {
    const isActive = activeTaskId === task.id
    const children = childrenByParent.get(task.id) ?? []
    const termState = terminalStates?.get(task.id)
    const progress = taskProgress?.get(task.id)
    const isDone = doneTaskIds?.has(task.id) ?? false
    const cols = columnsByProjectId?.get(task.project_id) ?? null
    const statusStyle = getColumnStatusStyle(task.status, cols)
    const StatusIcon = statusStyle?.icon
    const button = (
      <button
        type="button"
        data-sidebar-tree-item="task"
        data-task-id={task.id}
        data-active={isActive ? 'true' : undefined}
        onClick={() => onTaskClick?.(task.id)}
        style={{ paddingLeft: tgPaddingLeft(depth), minHeight: TG_ROW_HEIGHT }}
        className="relative flex w-full items-center pr-1 text-sm text-left"
      >
        <TreeGuides depth={depth} ancestorFlags={ancestorFlags} />
        <span
          className={cn(
            'flex flex-1 items-center gap-2 rounded-md px-1.5 py-1 min-w-0 transition-colors',
            isActive
              ? 'bg-white/10 text-foreground'
              : 'text-muted-foreground hover:bg-accent/40 hover:text-accent-foreground'
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
              treeCrossOutDone && isDone && 'line-through text-muted-foreground/60'
            )}
          >
            {task.title || 'Untitled'}
          </span>
          {treeShowWorktree && task.worktree_path && (
            <GitBranch
              aria-label="Worktree"
              className={cn('size-3.5 shrink-0', !task.worktree_color && 'text-muted-foreground/60')}
              style={task.worktree_color ? { color: task.worktree_color } : undefined}
            />
          )}
          {pinnedSet.has(task.id) && (
            <Pin
              aria-label="Pinned"
              className="size-3 shrink-0 text-muted-foreground/60 -rotate-45 fill-current"
            />
          )}
          {treeShowPriority && task.priority != null && (
            <PriorityIcon priority={task.priority} className="size-3.5 shrink-0" />
          )}
          {treeShowStatus && StatusIcon && (
            <StatusIcon className={cn('size-3.5 shrink-0', statusStyle?.iconClass)} />
          )}
        </span>
      </button>
    )
    return (
      <div key={task.id}>
        {taskContextMenuRender ? taskContextMenuRender(task, button) : button}
        {children.map((c, i) => renderTask(c, depth + 1, [...ancestorFlags, i < children.length - 1]))}
      </div>
    )
  }

  const renderProject = (project: typeof sortedProjects[number]) => {
    const projectTasks = tasksByProject.get(project.id) ?? []
    const rootTasks = rootTasksByProject.get(project.id) ?? []
    const isOpen = openProjects[project.id] ?? false

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
          className="group/projectrow relative flex items-center gap-0.5 transition-[filter] hover:brightness-125"
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
              className="flex flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm min-w-0"
            >
              <span className="truncate flex-1 text-left">{project.name}</span>
            </button>
          </Collapsible.Trigger>
          <button
            type="button"
            onClick={() => onSelectProject(project.id)}
            aria-label={`Open ${project.name} home`}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/50 hover:text-foreground opacity-0 group-hover/projectrow:opacity-100 focus-visible:opacity-100 transition-[color,opacity]"
          >
            <Home className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onProjectSettings(project)}
            aria-label={`Settings for ${project.name}`}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/50 hover:text-foreground opacity-0 group-hover/projectrow:opacity-100 focus-visible:opacity-100 transition-[color,opacity] mr-0.5"
          >
            <Settings className="size-3.5" />
          </button>
        </div>
        <Collapsible.Content className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
          <div className="flex flex-col pr-2 pt-2 pb-2">
            {projectTasks.length === 0 ? (
              <span className="text-xs italic text-muted-foreground/60 px-2 py-1">
                No active tasks
              </span>
            ) : (
              rootTasks.map((task, i) => renderTask(task, 1, [i < rootTasks.length - 1]))
            )}
          </div>
        </Collapsible.Content>
      </Collapsible.Root>
    )
  }

  return (
    <div className="flex flex-col gap-3 px-1">
      {visibleProjects.map(renderProject)}
      {hiddenProjects.length > 0 && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="flex items-center justify-center gap-1 px-2 py-2 text-[11px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
        >
          <span>{showAll ? 'Hide inactive' : 'Show all'}</span>
          <ChevronDown className={cn('size-3 transition-transform', showAll && 'rotate-180')} />
        </button>
      )}
    </div>
  )
}
