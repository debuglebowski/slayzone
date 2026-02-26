import { useEffect, useState } from 'react'
import type { Task } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'
import type { TerminalState } from '@slayzone/terminal/shared'
import {
  cn,
  getTerminalStateStyle,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@slayzone/ui'
import { usePty } from '@slayzone/terminal'
import { PRIORITY_LABELS } from './kanban'
import { GitMerge, Link2, Trash2 } from 'lucide-react'

interface AgentListRowProps {
  task: Task
  onClick?: (e: React.MouseEvent) => void
  onDelete?: (taskId: string) => void
  isFocused?: boolean
  project?: Project
  showProject?: boolean
  isBlocked?: boolean
  subTaskCount?: { done: number; total: number }
}

const PRIORITY_COLORS: Record<number, string> = {
  1: 'text-red-500',
  2: 'text-orange-500',
  3: 'text-yellow-500',
  4: 'text-blue-400',
  5: 'text-muted-foreground/50'
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function AgentListRow({
  task,
  onClick,
  onDelete,
  isFocused,
  project,
  showProject,
  isBlocked,
  subTaskCount
}: AgentListRowProps): React.JSX.Element {
  const { getState, subscribeState } = usePty()
  const mainSessionId = `${task.id}:${task.id}`
  const [terminalState, setTerminalState] = useState<TerminalState>(() => getState(mainSessionId))
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)

  useEffect(() => {
    setTerminalState(getState(mainSessionId))
    return subscribeState(mainSessionId, (s) => setTerminalState(s))
  }, [mainSessionId, getState, subscribeState])

  const termStyle = terminalState !== 'starting' ? getTerminalStateStyle(terminalState) : null

  return (
    <button
      className={cn(
        'w-full flex items-center gap-3 px-3 py-2.5 text-left rounded-lg transition-colors duration-[400ms] hover:duration-[100ms]',
        'hover:bg-muted/50 group',
        isFocused && 'bg-muted/50 ring-1 ring-primary'
      )}
      data-task-id={task.id}
      onClick={onClick}
    >
      {/* Terminal state indicator */}
      <div className="shrink-0 flex items-center justify-center w-5">
        {termStyle ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className={cn('h-2.5 w-2.5 rounded-full', termStyle.color)} />
            </TooltipTrigger>
            <TooltipContent side="right">{termStyle.label}</TooltipContent>
          </Tooltip>
        ) : (
          <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/15" />
        )}
      </div>

      {/* Project dot */}
      {showProject && (
        <div
          className="h-2 w-2 rounded-full shrink-0"
          style={{ backgroundColor: project?.color ?? 'var(--muted-foreground)' }}
          title={project?.name}
        />
      )}

      {/* Title */}
      <span className={cn(
        'flex-1 text-sm truncate min-w-0',
        task.status === 'done' && 'line-through text-muted-foreground'
      )}>
        {task.title}
      </span>

      {/* Indicators */}
      <div className="flex items-center gap-2 shrink-0">
        {task.merge_state && (
          <Tooltip>
            <TooltipTrigger asChild>
              <GitMerge className="h-3.5 w-3.5 text-purple-400" />
            </TooltipTrigger>
            <TooltipContent>Merging</TooltipContent>
          </Tooltip>
        )}
        {task.linear_url && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="h-2 w-2 rounded-full bg-indigo-500" />
            </TooltipTrigger>
            <TooltipContent>Linked to Linear</TooltipContent>
          </Tooltip>
        )}
        {isBlocked && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Link2 className="h-3.5 w-3.5 text-amber-500" />
            </TooltipTrigger>
            <TooltipContent>Blocked</TooltipContent>
          </Tooltip>
        )}

        {/* Sub-task count */}
        {subTaskCount && subTaskCount.total > 0 && (
          <span className={cn(
            'text-[11px] tabular-nums',
            subTaskCount.done === subTaskCount.total ? 'text-green-500' : 'text-muted-foreground'
          )}>
            {subTaskCount.done}/{subTaskCount.total}
          </span>
        )}

        {/* Priority (only non-default) */}
        {task.priority <= 2 && (
          <span className={cn('text-[11px]', PRIORITY_COLORS[task.priority])}>
            {PRIORITY_LABELS[task.priority]}
          </span>
        )}

        {/* Terminal state label */}
        {termStyle && (
          <span className={cn('text-[11px] font-medium', termStyle.textColor)}>
            {termStyle.label}
          </span>
        )}

        {/* Updated time */}
        <span className="text-[11px] text-muted-foreground w-14 text-right tabular-nums">
          {relativeTime(task.updated_at)}
        </span>

        {/* Delete button (hover only) */}
        {onDelete && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                role="button"
                tabIndex={-1}
                className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-destructive/10 hover:text-destructive text-muted-foreground/50"
                onClick={(e) => {
                  e.stopPropagation()
                  setDeleteDialogOpen(true)
                }}
              >
                <Trash2 className="size-3.5" />
              </span>
            </TooltipTrigger>
            <TooltipContent>Delete</TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* Delete confirmation dialog */}
      {onDelete && (
        <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Task</AlertDialogTitle>
              <AlertDialogDescription>
                Delete &ldquo;{task.title}&rdquo;? This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => { onDelete(task.id); setDeleteDialogOpen(false) }}>
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </button>
  )
}
