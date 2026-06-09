import { useMutation } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import type { Task } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'
import { isTerminalStatus } from '@slayzone/projects/shared'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@slayzone/ui'
import { buildStatusOptions, cn } from '@slayzone/ui'
import { track } from '@slayzone/telemetry/client'
import { ProjectSelect } from '@slayzone/projects'

interface ProjectStatusCardProps {
  task: Task
  onUpdate: (task: Task) => void
  columnsConfig: Project['columns_config'] | undefined
}

export function ProjectStatusCard({
  task,
  onUpdate,
  columnsConfig
}: ProjectStatusCardProps): React.JSX.Element {
  const trpc = useTRPC()
  const updateTask = useMutation(trpc.task.update.mutationOptions())
  const statusOptions = buildStatusOptions(columnsConfig)

  const handleStatusChange = async (status: string): Promise<void> => {
    track('task_status_changed', { from: task.status, to: status })
    if (isTerminalStatus(status, columnsConfig)) {
      track('task_completed', {
        provider: task.terminal_mode ?? 'terminal',
        had_worktree: Boolean(task.worktree_path)
      })
    }
    const updated = await updateTask.mutateAsync({ id: task.id, status })
    onUpdate(updated)
  }

  const handleProjectChange = async (projectId: string): Promise<void> => {
    track('task_moved_to_project')
    const updated = await updateTask.mutateAsync({ id: task.id, projectId })
    onUpdate(updated)
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      <div>
        <label className="mb-1 block text-sm text-muted-foreground">Project</label>
        <ProjectSelect value={task.project_id} onChange={handleProjectChange} />
      </div>
      <div>
        <label className="mb-1 block text-sm text-muted-foreground">Status</label>
        <Select value={task.status} onValueChange={handleStatusChange}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {statusOptions.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                <span className="flex items-center gap-1.5">
                  <opt.icon className={cn('size-3.5', opt.iconClass)} />
                  {opt.label}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
