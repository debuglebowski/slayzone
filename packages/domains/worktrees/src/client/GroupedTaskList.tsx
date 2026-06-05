import { useState, useCallback, useMemo } from 'react'
import { TerminalSquare, ChevronDown, ChevronRight } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  PriorityIcon
} from '@slayzone/ui'
import { type FilterState, groupTasksBy, getViewConfig, type Column } from '@slayzone/tasks'
import { resolveColumns } from '@slayzone/projects/shared'
import type { Task } from '@slayzone/task/shared'
import { useGitPanelContext } from './git-panel-context'

export function GroupedTaskList({
  tasks,
  tooltip,
  onTaskClick
}: {
  tasks: Task[]
  tooltip?: string
  onTaskClick?: (task: Task) => void | Promise<void>
}) {
  const { filter, projects, onTaskClick: contextOnTaskClick } = useGitPanelContext()
  const clickHandler = onTaskClick ?? contextOnTaskClick
  const groups = useMemo(() => {
    if (!filter) return [{ id: 'all', title: 'All Tasks', tasks }]
    const vc = getViewConfig(filter)
    // Find column config for current project
    const project = projects.find((p) => tasks.some((t) => t.project_id === p.id))
    return groupTasksBy(tasks, vc.groupBy, vc.sortBy, project?.columns_config)
  }, [tasks, filter, projects])

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => {
    const initial = new Set<string>()

    // Get column config to match categories
    const project = projects.find((p) => tasks.some((t) => t.project_id === p.id))
    const columns = resolveColumns(project?.columns_config)
    const vc = getViewConfig(filter || ({} as FilterState))

    groups.forEach((g) => {
      // 1. If grouping by status, check workflow category
      if (!filter || vc.groupBy === 'status') {
        const col = columns.find((c) => c.id === g.id)
        if (col && (col.category === 'started' || col.category === 'unstarted')) {
          initial.add(g.id)
          return
        }
      }

      // 2. Fallback to label matching for other group types (priority, etc)
      const title = g.title.toLowerCase()
      if (title.includes('started')) {
        initial.add(g.id)
      }
    })

    // If nothing matched, expand first non-empty group
    if (initial.size === 0 && groups.length > 0) {
      const firstWithTasks = groups.find((g) => g.tasks.length > 0)
      if (firstWithTasks) initial.add(firstWithTasks.id)
    }
    return initial
  })

  const toggleGroup = useCallback((id: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // If only one group and it's "All Tasks" or similar, just render the list
  if (groups.length === 1 && (groups[0].id === 'all' || groups[0].id === 'active')) {
    return (
      <div className="space-y-2">
        {groups[0].tasks.map((task: Task) => (
          <TaskItem key={task.id} task={task} onClick={clickHandler} tooltip={tooltip} />
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {groups
        .filter((g: Column) => g.tasks.length > 0)
        .map((group: Column) => {
          const isExpanded = expandedGroups.has(group.id)
          return (
            <div key={group.id} className="space-y-2">
              <button
                onClick={() => toggleGroup(group.id)}
                className="flex items-center gap-2 w-full px-1 py-0.5 hover:bg-muted/30 rounded transition-colors group/group-header"
              >
                <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70 group-hover/group-header:text-foreground/80">
                  {group.title}
                </span>
                <div className="h-px bg-border/30 flex-1" />
                <span className="text-[10px] font-medium text-muted-foreground/50">
                  {group.tasks.length}
                </span>
                {isExpanded ? (
                  <ChevronDown className="h-3 w-3 text-muted-foreground/50 group-hover/group-header:text-foreground/80" />
                ) : (
                  <ChevronRight className="h-3 w-3 text-muted-foreground/50 group-hover/group-header:text-foreground/80" />
                )}
              </button>

              {isExpanded && (
                <div className="space-y-1.5 animate-in fade-in slide-in-from-top-1 duration-200">
                  {group.tasks.map((task: Task) => (
                    <TaskItem key={task.id} task={task} onClick={clickHandler} tooltip={tooltip} />
                  ))}
                </div>
              )}
            </div>
          )
        })}
    </div>
  )
}

function TaskItem({
  task,
  onClick,
  tooltip = 'Go to task'
}: {
  task: Task
  onClick?: (task: Task) => void
  tooltip?: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={() => onClick?.(task)}
          className="flex items-center gap-2.5 w-full rounded-md border transition-all group/task px-2.5 py-2 bg-surface-3 text-sm text-foreground hover:border-primary/50 hover:bg-muted/50 shadow-sm"
        >
          <PriorityIcon priority={task.priority} className="h-3.5 w-3.5 shrink-0" />
          <TerminalSquare className="h-4 w-4 shrink-0 text-primary/70 group-hover/task:text-primary" />
          <span className="truncate flex-1 text-left font-medium">{task.title}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}
