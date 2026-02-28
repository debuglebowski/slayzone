import { useMemo } from 'react'
import { X } from 'lucide-react'
import { Button, cn, Tooltip, TooltipTrigger, TooltipContent } from '@slayzone/ui'
import type { AttentionTask } from './useAttentionTasks'
import type { Project } from '@slayzone/projects/shared'

interface NotificationPanelProps {
  attentionTasks: AttentionTask[]
  projects: Project[]
  filterCurrentProject: boolean
  onFilterToggle: () => void
  onNavigate: (taskId: string) => void
  onCloseTerminal: (sessionId: string) => void
  selectedProjectId: string | null
  currentProjectName?: string
}

function formatIdleTime(lastOutputTime: number): string {
  const seconds = Math.floor((Date.now() - lastOutputTime) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h`
}

const STATUS_ORDER = ['in_progress', 'todo', 'backlog', 'inbox', 'review', 'done'] as const
const STATUS_LABELS: Record<string, string> = {
  inbox: 'Inbox',
  backlog: 'Backlog',
  todo: 'Todo',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done'
}

export function NotificationPanel({
  attentionTasks,
  projects,
  filterCurrentProject,
  onFilterToggle,
  onNavigate,
  onCloseTerminal,
  selectedProjectId,
  currentProjectName
}: NotificationPanelProps) {
  const getProjectColor = (projectId: string | null): string | undefined => {
    if (!projectId) return undefined
    return projects.find((p) => p.id === projectId)?.color
  }

  // Group tasks by status
  const groupedTasks = useMemo(() => {
    const groups = new Map<string, AttentionTask[]>()
    for (const item of attentionTasks) {
      const status = item.task.status
      if (!groups.has(status)) groups.set(status, [])
      groups.get(status)!.push(item)
    }
    // Sort by STATUS_ORDER
    return STATUS_ORDER.filter((s) => groups.has(s)).map((status) => ({
      status,
      label: STATUS_LABELS[status] || status,
      tasks: groups.get(status)!
    }))
  }, [attentionTasks])

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center bg-surface-2 p-1 gap-1 m-4 mb-0 rounded-lg">
        <button
          onClick={() => filterCurrentProject && onFilterToggle()}
          className={cn(
            'flex-1 px-2.5 py-1 rounded-md text-xs font-medium transition-colors',
            !filterCurrentProject
              ? 'bg-muted text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          All
        </button>
        {selectedProjectId && (
          <button
            onClick={() => !filterCurrentProject && onFilterToggle()}
            className={cn(
              'flex-1 px-2.5 py-1 rounded-md text-xs font-medium transition-colors truncate',
              filterCurrentProject
                ? 'bg-muted text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {currentProjectName || 'Current'}
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0 relative">
        <div className="absolute inset-0 overflow-y-auto p-4 pt-6">
        {attentionTasks.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">No tasks need attention</p>
        ) : (
          groupedTasks.map(({ status, label, tasks }) => (
            <div key={status} className="mb-3">
              <div className="text-xs font-medium text-muted-foreground px-2 py-1">{label}</div>
              <div className="space-y-2">
                {tasks.map(({ task, sessionId, lastOutputTime }) => (
                  <div
                    key={task.id}
                    className="rounded-lg border bg-card p-3 shadow-sm hover:bg-accent/50 transition-colors cursor-pointer"
                    onClick={() => onNavigate(task.id)}
                  >
                    <div className="flex items-start gap-2">
                      {!filterCurrentProject && (
                        <span
                          className={cn('w-2 h-2 rounded-full flex-shrink-0 mt-1.5')}
                          style={{ backgroundColor: getProjectColor(task.project_id) || 'var(--muted-foreground)' }}
                        />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium">{task.title}</div>
                      </div>
                    </div>
                    <div className="flex items-center justify-between mt-2 pt-2 border-t">
                      <span className="text-xs text-muted-foreground">
                        {formatIdleTime(lastOutputTime)} ago
                      </span>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-muted-foreground hover:text-destructive"
                            onClick={(e) => {
                              e.stopPropagation()
                              onCloseTerminal(sessionId)
                            }}
                          >
                            <X className="size-3" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Kill terminal process</TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
        </div>
      </div>
    </div>
  )
}
