import { useEffect, useMemo, useState } from 'react'
import { X, ChevronRight } from 'lucide-react'
import { IconButton, cn, Tooltip, TooltipTrigger, TooltipContent } from '@slayzone/ui'
import { track } from '@slayzone/telemetry/client'
import type { AttentionTask } from './useAttentionTasks'
import type { Project } from '@slayzone/projects/shared'
import { groupAttentionTasksByStatus } from './grouping'

interface NotificationPanelProps {
  attentionTasks: AttentionTask[]
  projects: Project[]
  filterCurrentProject: boolean
  onFilterToggle: () => void
  onNavigate: (taskId: string) => void
  onCloseTerminal: (sessionId: string) => void
  selectedProjectId: string
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
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  // Reset collapsed state when filter toggle changes
  useEffect(() => {
    setCollapsedGroups(new Set())
  }, [filterCurrentProject])

  // Group tasks by status
  const groupedTasks = useMemo(
    () => groupAttentionTasksByStatus(attentionTasks, projects, filterCurrentProject, selectedProjectId),
    [attentionTasks, projects, selectedProjectId, filterCurrentProject]
  )

  const toggleGroup = (status: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      next.has(status) ? next.delete(status) : next.add(status)
      return next
    })
  }

  const getProjectColor = (projectId: string | null): string | undefined => {
    if (!projectId) return undefined
    return projects.find((p) => p.id === projectId)?.color
  }

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
          groupedTasks.map(({ status, label, tasks }) => {
            const collapsed = collapsedGroups.has(status)
            return (
            <div key={status} className="mb-3">
              <button
                type="button"
                aria-expanded={!collapsed}
                aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${label} group`}
                onClick={() => toggleGroup(status)}
                className="flex w-full items-center gap-1 px-2 py-1 rounded hover:bg-muted/50 transition-colors"
              >
                <ChevronRight className={cn('size-3 text-muted-foreground transition-transform', !collapsed && 'rotate-90')} />
                <span className="text-xs font-medium text-muted-foreground">{label}</span>
                {collapsed && <span className="ml-auto text-[10px] text-muted-foreground/60">{tasks.length}</span>}
              </button>
              {!collapsed && <div className="space-y-2 mt-1">
                {tasks.map(({ task, sessionId, lastOutputTime }) => (
                  <div
                    key={task.id}
                    className="rounded-lg border bg-card p-3 shadow-sm hover:bg-accent/50 transition-colors cursor-pointer"
                    onClick={() => {
                      track('notification_clicked')
                      onNavigate(task.id)
                    }}
                  >
                    <div className="flex items-start gap-2">
                      {!filterCurrentProject && (
                        <span
                          className={cn('w-2 h-2 rounded-full flex-shrink-0 mt-1.5')}
                          style={{ backgroundColor: getProjectColor(task.project_id) || '#888' }}
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
                          <IconButton
                            aria-label="Dismiss notification"
                            variant="ghost"
                            className="h-6 w-6 text-muted-foreground hover:text-destructive"
                            onClick={(e) => {
                              e.stopPropagation()
                              onCloseTerminal(sessionId)
                            }}
                          >
                            <X className="size-3" />
                          </IconButton>
                        </TooltipTrigger>
                        <TooltipContent>Kill terminal process</TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                ))}
              </div>}
            </div>
          )})
        )}
        </div>
      </div>
    </div>
  )
}
