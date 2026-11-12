import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTRPC, useTRPCClient } from './trpc'
import { MoveTaskDialog } from './MoveTaskDialog'
import type { Task } from '@slayzone/task-contracts'
import type { Project } from '@slayzone/projects-contracts'
import { isTerminalStatus } from '@slayzone/projects-contracts'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@slayzone/ui'
import { buildStatusOptions, cn } from '@slayzone/ui'
import { useTrack } from '@slayzone/telemetry/client'
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
  const { trackTask } = useTrack()
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  /** The project picked: the move dialog confirms it (a move can't be undone). */
  const [moveTargetId, setMoveTargetId] = useState<string | null>(null)
  const updateTask = useMutation(trpc.task.update.mutationOptions())
  const statusOptions = buildStatusOptions(columnsConfig)

  const handleStatusChange = async (status: string): Promise<void> => {
    trackTask(task.id, 'task_status_changed', { from: task.status, to: status })
    if (isTerminalStatus(status, columnsConfig)) {
      trackTask(task.id, 'task_completed', {
        provider: task.agent_id ?? 'terminal',
        had_worktree: Boolean(task.has_worktree)
      })
    }
    const updated = await updateTask.mutateAsync({ id: task.id, status })
    onUpdate(updated)
  }

  const handleProjectChange = (projectId: string): void => {
    if (projectId !== task.project_id) setMoveTargetId(projectId)
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      <div data-testid="task-project-field">
        <label className="mb-1 block text-sm text-muted-foreground">Project</label>
        <ProjectSelect value={task.project_id} onChange={handleProjectChange} />
        {moveTargetId !== null && (
          <MoveTaskDialog
            open
            onOpenChange={(open) => {
              if (!open) setMoveTargetId(null)
            }}
            taskIds={[task.id]}
            initialProjectId={moveTargetId}
            onMoved={() => {
              trpcClient.task.get
                .query({ id: task.id })
                .then((moved) => {
                  if (moved) onUpdate(moved)
                })
                .catch(() => {
                  /* the board's tasks-changed refresh brings it anyway */
                })
            }}
          />
        )}
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
