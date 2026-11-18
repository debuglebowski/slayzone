import { useMutation, useQuery } from '@tanstack/react-query'
import type { Task } from '@slayzone/task-contracts'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, toast } from '@slayzone/ui'
import { useDirectory, useSharingStatus } from '@slayzone/projects/client'
import { useTRPC } from './trpc'

const NOBODY = '__nobody__'

/**
 * Task details → Assignee (T-100): one of the people in the task's project — its
 * owner or a member. Only on a hub with login (one operator otherwise). An external
 * system's assignee (Linear, Jira, GitHub: `assignee`) is shown beside it, unchanged.
 */
export function AssigneeCard({
  task,
  onUpdate
}: {
  task: Task
  onUpdate: (task: Task) => void
}): React.JSX.Element | null {
  const { enabled } = useSharingStatus()
  if (!enabled) return null
  return <Assignee task={task} onUpdate={onUpdate} />
}

function Assignee({
  task,
  onUpdate
}: {
  task: Task
  onUpdate: (task: Task) => void
}): React.JSX.Element {
  const trpc = useTRPC()
  const { nameOf } = useDirectory(true)
  const membersQuery = useQuery(
    trpc.sharing.projectMembers.queryOptions({ projectId: task.project_id })
  )
  const updateTask = useMutation(trpc.task.update.mutationOptions())
  const people = [
    ...(membersQuery.data?.ownerUserId ? [membersQuery.data.ownerUserId] : []),
    ...(membersQuery.data?.members ?? []).map((m) => m.userId)
  ]
  const current = task.assignee_user_id ?? null
  // Someone assigned earlier who is no longer in the project: still shown.
  if (current && !people.includes(current)) people.push(current)

  const assign = async (value: string): Promise<void> => {
    const assigneeUserId = value === NOBODY ? null : value
    const updated = await updateTask
      .mutateAsync({ id: task.id, assigneeUserId })
      .catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : String(err))
        return null
      })
    if (updated) onUpdate(updated)
  }

  return (
    <div data-testid="task-assignee-card">
      <label className="mb-1 block text-sm text-muted-foreground">Assignee</label>
      <Select value={current ?? NOBODY} onValueChange={(v) => void assign(v)}>
        <SelectTrigger className="w-full" data-testid="task-assignee">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NOBODY}>Nobody</SelectItem>
          {people.map((id) => (
            <SelectItem key={id} value={id}>
              {nameOf(id)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {task.assignee && (
        <p className="mt-1 text-xs text-muted-foreground">External: {task.assignee}</p>
      )}
    </div>
  )
}
