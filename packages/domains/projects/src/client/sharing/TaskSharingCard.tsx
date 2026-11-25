import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Lock, Users, X } from 'lucide-react'
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@slayzone/ui'
import { useTRPC } from '../trpc'
import { AddPersonButton } from './AddPersonDialog'
import { RoleSelect } from './PeoplePicker'
import { ROLE_LABEL, toastError, useDirectory, useMyRole, useSharingStatus } from './useSharing'
import type { AccessRole } from './useSharing'

const ROLES: readonly AccessRole[] = ['view', 'edit', 'manage']

/**
 * Task details → Sharing (T-100): whether the whole project sees the task or only its
 * creator and the people invited, and who is invited. Renders nothing on a hub
 * without login (one operator, nobody to share with).
 */
export function TaskSharingCard({ taskId }: { taskId: string }): React.JSX.Element | null {
  const { enabled } = useSharingStatus()
  if (!enabled) return null
  return <TaskSharing taskId={taskId} />
}

function TaskSharing({ taskId }: { taskId: string }): React.JSX.Element {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const myRole = useMyRole('task', taskId)
  const canManage = myRole === 'manage'
  const { users, nameOf } = useDirectory(true)
  const sharingQuery = useQuery(trpc.sharing.taskSharing.queryOptions({ taskId }))
  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.sharing.pathKey() })
  const opts = { onSuccess: refresh, onError: toastError }
  const setVisibility = useMutation(trpc.sharing.setTaskVisibility.mutationOptions(opts))
  const setGrant = useMutation(trpc.sharing.setTaskGrant.mutationOptions(opts))
  const removeGrant = useMutation(trpc.sharing.removeTaskGrant.mutationOptions(opts))

  const s = sharingQuery.data
  if (!s) return <div className="h-14" />
  const isRoot = s.rootTaskId === taskId
  const invited = new Set([
    ...(s.createdByUserId ? [s.createdByUserId] : []),
    ...s.grants.map((g) => g.userId)
  ])

  return (
    <div data-testid="task-sharing-card">
      <label className="mb-1 block text-sm text-muted-foreground">Sharing</label>
      <div className="flex items-center gap-1.5">
        {isRoot ? (
          <Select
            value={s.visibility}
            disabled={!canManage}
            onValueChange={(v) =>
              setVisibility.mutate({ taskId, visibility: v as 'project' | 'private' })
            }
          >
            <SelectTrigger className="min-w-0 flex-1" data-testid="task-visibility">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="project">
                <Users className="mr-1.5 inline size-3.5" />
                Everyone in the project
              </SelectItem>
              <SelectItem value="private">
                <Lock className="mr-1.5 inline size-3.5" />
                Private — {nameOf(s.createdByUserId)} and invited people
              </SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            {s.visibility === 'private' ? 'Private' : 'Everyone in the project'} — follows its
            top-level task.
          </p>
        )}
        {canManage && (
          <AddPersonButton
            people={users}
            exclude={invited}
            roles={ROLES}
            projectId={s.projectId}
            visibility={s.visibility}
            creatorName={nameOf(s.createdByUserId)}
            onAdd={(userId, role) => setGrant.mutateAsync({ taskId, userId, role })}
          />
        )}
      </div>
      {(s.grants.length > 0 || s.inherited.length > 0) && (
        <ul className="mt-2 space-y-1">
          {s.grants.map((g) => (
            <li
              key={g.userId}
              className="flex items-center justify-between gap-1"
              data-testid={`task-grant-${g.userId}`}
            >
              <span className="min-w-0 truncate text-sm">{nameOf(g.userId)}</span>
              <div className="flex items-center gap-1">
                <RoleSelect
                  value={g.role}
                  roles={ROLES}
                  disabled={!canManage}
                  onChange={(role) => setGrant.mutate({ taskId, userId: g.userId, role })}
                />
                {canManage && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${nameOf(g.userId)}`}
                    onClick={() => removeGrant.mutate({ taskId, userId: g.userId })}
                  >
                    <X className="size-4" />
                  </Button>
                )}
              </div>
            </li>
          ))}
          {s.inherited.map((g) => (
            <li
              key={`${g.taskId}:${g.userId}`}
              className="flex items-center justify-between gap-1 text-sm text-muted-foreground"
            >
              <span className="min-w-0 truncate">{nameOf(g.userId)}</span>
              <span className="text-xs">{ROLE_LABEL[g.role]} · from parent task</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
