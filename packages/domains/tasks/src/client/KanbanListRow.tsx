import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { Task } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'
import type { ColumnConfig } from '@slayzone/projects/shared'
import { isTerminalStatus } from '@slayzone/projects/shared'
import type { Tag } from '@slayzone/tags/shared'
import { PRIORITY_LABELS, todayISO } from './kanban'
import type { CardProperties } from './FilterState'
import { TaskContextMenu } from './TaskContextMenu'
import {
  cn,
  getTerminalStateStyle,
  TerminalProgressDot,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  PriorityIcon
} from '@slayzone/ui'
import { AlertCircle, AlarmClockOff, Check, GitMerge, Link2 } from 'lucide-react'
import { useSessionState } from '@slayzone/terminal'
import { formatSnoozeTimeLeft } from './KanbanListView.utils'

function PriorityBar({ priority }: { priority: number }): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="shrink-0">
          <PriorityIcon priority={priority} />
        </span>
      </TooltipTrigger>
      <TooltipContent>{PRIORITY_LABELS[priority]}</TooltipContent>
    </Tooltip>
  )
}

// ── Terminal state dot ──

function TerminalDot({ taskId }: { taskId: string }): React.JSX.Element | null {
  const terminalState = useSessionState(`${taskId}:${taskId}`)

  if (terminalState === 'starting') return null
  const style = getTerminalStateStyle(terminalState)
  if (!style) return null

  return <TerminalProgressDot state={terminalState} />
}

// ── Sortable list row ──

export interface ListRowProps {
  task: Task
  columns?: ColumnConfig[] | null
  cp?: CardProperties
  onClick?: (task: Task, e: { metaKey: boolean }) => void
  isBlocked?: boolean
  subTaskCount?: { done: number; total: number }
  disableDrag?: boolean
  allProjects?: Project[]
  onUpdateTask?: (taskId: string, updates: Partial<Task>) => void
  onArchiveTask?: (taskId: string) => void
  onDeleteTask?: (taskId: string) => void
  tags?: Tag[]
  taskTagIds?: string[]
  onTaskTagsChange?: (taskId: string, tagIds: string[]) => void
  activeAgentTaskIds?: Set<string>
  onShutdownAgent?: (taskId: string) => void
}

export function SortableListRow(props: ListRowProps): React.JSX.Element {
  const { task, disableDrag } = props
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    disabled: disableDrag
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition
  }

  const dragProps = disableDrag ? {} : { ...attributes, ...listeners }

  const row = <ListRowContent {...props} isDragging={isDragging} />

  const wrapped =
    props.allProjects && props.onUpdateTask && props.onArchiveTask && props.onDeleteTask ? (
      <TaskContextMenu
        task={task}
        projects={props.allProjects}
        columns={props.columns}
        tags={props.tags}
        taskTagIds={props.taskTagIds}
        isBlocked={props.isBlocked}
        onUpdateTask={props.onUpdateTask}
        onArchiveTask={props.onArchiveTask}
        onDeleteTask={props.onDeleteTask}
        onTaskTagsChange={props.onTaskTagsChange}
        onShutdownAgent={
          props.activeAgentTaskIds?.has(task.id) && props.onShutdownAgent
            ? () => props.onShutdownAgent!(task.id)
            : undefined
        }
      >
        <div ref={setNodeRef} style={style} {...dragProps}>
          {row}
        </div>
      </TaskContextMenu>
    ) : (
      <div ref={setNodeRef} style={style} {...dragProps}>
        {row}
      </div>
    )

  return wrapped
}

function ListRowContent({
  task,
  columns,
  cp,
  onClick,
  isBlocked,
  subTaskCount,
  isDragging
}: ListRowProps & { isDragging?: boolean }): React.JSX.Element {
  const today = todayISO()
  const isOverdue =
    task.due_date && task.due_date < today && !isTerminalStatus(task.status, columns)

  return (
    <div
      className={cn(
        'flex items-center gap-3 px-2.5 py-2.5 rounded-md cursor-pointer select-none transition-colors duration-[400ms] hover:duration-[100ms] hover:bg-muted/30',
        isDragging && 'opacity-50',
        isTerminalStatus(task.status, columns) && 'opacity-60'
      )}
      onClick={(e) => onClick?.(task, e)}
    >
      {/* Priority bar */}
      {(cp?.priority ?? true) && <PriorityBar priority={task.priority} />}

      {/* Title */}
      <span
        className={cn(
          'flex-1 text-sm font-medium truncate',
          isTerminalStatus(task.status, columns) && 'line-through text-muted-foreground'
        )}
      >
        {task.title}
      </span>

      {/* Right-side metadata */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Terminal state */}
        {(cp?.terminal ?? true) && <TerminalDot taskId={task.id} />}

        {/* Merge */}
        {(cp?.merge ?? true) && task.merge_state && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="shrink-0">
                <GitMerge className="h-3 w-3 text-purple-400" />
              </span>
            </TooltipTrigger>
            <TooltipContent>Merging</TooltipContent>
          </Tooltip>
        )}

        {/* Linear */}
        {(cp?.linear ?? true) && task.linear_url && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="shrink-0 h-2 w-2 rounded-full bg-indigo-500" />
            </TooltipTrigger>
            <TooltipContent>Linked to Linear</TooltipContent>
          </Tooltip>
        )}

        {/* Blocked */}
        {(cp?.blocked ?? true) && isBlocked && (
          <span className="flex items-center text-amber-500 shrink-0" title="Blocked">
            <Link2 className="h-3 w-3" />
          </span>
        )}
        {/* Snoozed */}
        {task.snoozed_until && new Date(task.snoozed_until) > new Date() && (
          <span
            className="flex items-center gap-0.5 text-orange-500 shrink-0"
            title={`Snoozed until ${new Date(task.snoozed_until).toLocaleString()}`}
          >
            <AlarmClockOff className="h-3 w-3" />
            <span className="text-[10px] font-medium">
              {formatSnoozeTimeLeft(task.snoozed_until)}
            </span>
          </span>
        )}

        {/* Due date */}
        {(cp?.dueDate ?? true) && isOverdue && (
          <span className="flex items-center gap-1 text-destructive shrink-0 text-[10px] font-medium">
            <AlertCircle className="h-3 w-3" />
            {task.due_date}
          </span>
        )}
        {(cp?.dueDate ?? true) && task.due_date && !isOverdue && (
          <span className="text-muted-foreground text-[10px] shrink-0">{task.due_date}</span>
        )}

        {/* Sub-tasks */}
        {(cp?.subtasks ?? true) && subTaskCount && subTaskCount.total > 0 && (
          <span
            className={cn(
              'flex items-center gap-0.5 text-[10px] shrink-0',
              subTaskCount.done === subTaskCount.total ? 'text-green-500' : 'text-muted-foreground'
            )}
          >
            <Check className="size-3" />
            {subTaskCount.done}/{subTaskCount.total}
          </span>
        )}
      </div>
    </div>
  )
}
