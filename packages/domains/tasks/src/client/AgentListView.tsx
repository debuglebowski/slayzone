import { useMemo, useState, useRef, useCallback } from 'react'
import type { Task } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'
import type { Tag } from '@slayzone/tags/shared'
import type { TerminalState } from '@slayzone/terminal/shared'
import type { SortKey } from './FilterState'
import { usePty } from '@slayzone/terminal'
import { cn } from '@slayzone/ui'
import { Plus } from 'lucide-react'
import { AgentListRow } from './AgentListRow'
import { TaskContextMenu } from './TaskContextMenu'

interface AgentListViewProps {
  tasks: Task[]
  sortBy?: SortKey
  onTaskClick?: (task: Task, e: { metaKey: boolean }) => void
  onCreateTask?: (title: string) => void
  projectsMap?: Map<string, Project>
  showProjectDot?: boolean
  taskTags?: Map<string, string[]>
  tags?: Tag[]
  blockedTaskIds?: Set<string>
  allProjects?: Project[]
  onUpdateTask?: (taskId: string, updates: Partial<Task>) => void
  onArchiveTask?: (taskId: string) => void
  onDeleteTask?: (taskId: string) => void
}

const ACTIVE_STATES = new Set<TerminalState>(['running', 'attention', 'error'])
const ONE_DAY = 24 * 60 * 60 * 1000

interface TaskGroup {
  label: string
  tasks: Task[]
}

function groupBySession(
  tasks: Task[],
  getTermState: (taskId: string) => TerminalState
): TaskGroup[] {
  const active: Task[] = []
  const today: Task[] = []
  const week: Task[] = []
  const older: Task[] = []
  const now = Date.now()

  for (const task of tasks) {
    const sessionId = `${task.id}:${task.id}`
    const termState = getTermState(sessionId)

    if (ACTIVE_STATES.has(termState)) {
      active.push(task)
    } else {
      const age = now - new Date(task.updated_at).getTime()
      if (age < ONE_DAY) today.push(task)
      else if (age < 7 * ONE_DAY) week.push(task)
      else older.push(task)
    }
  }

  const groups: TaskGroup[] = []
  if (active.length > 0) groups.push({ label: 'Active', tasks: active })
  if (today.length > 0) groups.push({ label: 'Today', tasks: today })
  if (week.length > 0) groups.push({ label: 'This week', tasks: week })
  if (older.length > 0) groups.push({ label: 'Older', tasks: older })
  return groups
}

function InlineCreateInput({ onSubmit }: { onSubmit: (title: string) => void }): React.JSX.Element {
  const [value, setValue] = useState('')
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim()
    if (!trimmed) return
    onSubmit(trimmed)
    setValue('')
  }, [value, onSubmit])

  return (
    <div
      className={cn(
        'mx-3 mt-3 mb-1 flex items-center gap-3 rounded-lg border border-dashed px-3 py-2.5 transition-colors cursor-text',
        focused
          ? 'border-primary/50 bg-primary/5'
          : 'border-muted-foreground/25 hover:border-muted-foreground/40 hover:bg-muted/50'
      )}
      onClick={() => inputRef.current?.focus()}
    >
      <Plus className={cn('size-5 shrink-0 transition-colors', focused ? 'text-primary' : 'text-muted-foreground')} />
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleSubmit()
          if (e.key === 'Escape') { setValue(''); inputRef.current?.blur() }
        }}
        placeholder="New task…"
        className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50"
      />
      {value.trim() && (
        <kbd className="text-[11px] text-muted-foreground/60 font-[system-ui] select-none">↩</kbd>
      )}
    </div>
  )
}

export function AgentListView({
  tasks,
  onTaskClick,
  onCreateTask,
  projectsMap,
  showProjectDot,
  blockedTaskIds,
  allProjects,
  onUpdateTask,
  onArchiveTask,
  onDeleteTask
}: AgentListViewProps): React.JSX.Element {
  const { getState } = usePty()

  const groups = useMemo(
    () => groupBySession(tasks, (sessionId) => getState(sessionId)),
    [tasks, getState]
  )

  const subTaskCounts = useMemo(() => {
    const counts = new Map<string, { done: number; total: number }>()
    for (const t of tasks) {
      if (!t.parent_id) continue
      const entry = counts.get(t.parent_id) ?? { done: 0, total: 0 }
      entry.total++
      if (t.status === 'done') entry.done++
      counts.set(t.parent_id, entry)
    }
    return counts
  }, [tasks])

  return (
    <div className="h-full overflow-y-auto [&::-webkit-scrollbar]:hidden">
      {onCreateTask && <InlineCreateInput onSubmit={onCreateTask} />}

      {groups.length === 0 && (
        <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
          No tasks
        </div>
      )}

      {groups.map((group) => (
        <div key={group.label}>
          <div className="px-3 pt-3 pb-1">
            <span className={cn(
              'text-[11px] font-semibold uppercase tracking-wider',
              group.label === 'Active' ? 'text-green-500' : 'text-muted-foreground/70'
            )}>
              {group.label}
            </span>
          </div>
          <div className="flex flex-col gap-px">
            {group.tasks.map((task) => {
              const row = (
                <AgentListRow
                  key={task.id}
                  task={task}
                  onClick={(e) => onTaskClick?.(task, { metaKey: e.metaKey })}
                  onDelete={onDeleteTask}
                  project={showProjectDot ? projectsMap?.get(task.project_id) : undefined}
                  showProject={showProjectDot}
                  isBlocked={blockedTaskIds?.has(task.id)}
                  subTaskCount={subTaskCounts.get(task.id)}
                />
              )

              if (onUpdateTask && onArchiveTask && onDeleteTask && allProjects) {
                return (
                  <TaskContextMenu
                    key={task.id}
                    task={task}
                    projects={allProjects}
                    onUpdateTask={onUpdateTask}
                    onArchiveTask={onArchiveTask}
                    onDeleteTask={onDeleteTask}
                  >
                    {row}
                  </TaskContextMenu>
                )
              }
              return row
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
