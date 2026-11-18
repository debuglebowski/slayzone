import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { Button } from '@slayzone/ui'
import type { Project } from '@slayzone/projects-contracts'
import { useTRPC } from '../trpc'
import { PeoplePicker, RoleSelect } from './PeoplePicker'
import { toastError, useDirectory, useMyRole, type AccessRole } from './useSharing'

const ROLES: readonly AccessRole[] = ['view', 'edit', 'manage']

/**
 * Project settings → Members (T-100): who besides the owner may reach this project,
 * and with which role. Only its owner and managers change it; everyone in it sees it.
 * Private tasks stay their creator's whatever the role here.
 */
export function MembersTab({ project }: { project: Project }): React.JSX.Element {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const myRole = useMyRole('project', project.id)
  const canManage = myRole === 'manage'
  const { users, nameOf, byId } = useDirectory(true)
  const membersQuery = useQuery(trpc.sharing.projectMembers.queryOptions({ projectId: project.id }))
  const refresh = () =>
    queryClient.invalidateQueries(
      trpc.sharing.projectMembers.queryFilter({ projectId: project.id })
    )
  const setMember = useMutation(
    trpc.sharing.setProjectMember.mutationOptions({ onSuccess: refresh, onError: toastError })
  )
  const removeMember = useMutation(
    trpc.sharing.removeProjectMember.mutationOptions({ onSuccess: refresh, onError: toastError })
  )
  const data = membersQuery.data
  const ownerId = data?.ownerUserId ?? null
  const members = data?.members ?? []
  const inProject = new Set([...(ownerId ? [ownerId] : []), ...members.map((m) => m.userId)])

  return (
    <div className="space-y-4" data-testid="project-members-tab">
      <div>
        <h3 className="text-sm font-medium">Members</h3>
        <p className="text-xs text-muted-foreground">
          Members see this project's tasks and files on the hub. Terminals, chats and worktrees stay
          on each person's own computer. A private task is seen only by its creator and the people
          invited to it.
        </p>
      </div>
      <ul className="divide-y divide-border rounded-md border border-border">
        <li className="flex items-center justify-between gap-2 px-3 py-2">
          <Person name={nameOf(ownerId)} email={ownerId ? byId.get(ownerId)?.email : undefined} />
          <span className="text-xs text-muted-foreground">Owner</span>
        </li>
        {members.map((m) => (
          <li
            key={m.userId}
            className="flex items-center justify-between gap-2 px-3 py-2"
            data-testid={`project-member-${m.userId}`}
          >
            <Person name={nameOf(m.userId)} email={byId.get(m.userId)?.email} />
            <div className="flex items-center gap-1">
              <RoleSelect
                value={m.role}
                roles={ROLES}
                disabled={!canManage}
                onChange={(role) =>
                  setMember.mutate({ projectId: project.id, userId: m.userId, role })
                }
              />
              {canManage && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${nameOf(m.userId)}`}
                  onClick={() => removeMember.mutate({ projectId: project.id, userId: m.userId })}
                >
                  <X className="size-4" />
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {canManage && (
        <PeoplePicker
          people={users}
          exclude={inProject}
          roles={ROLES}
          testId="project-member-picker"
          onAdd={(userId, role) =>
            setMember.mutateAsync({ projectId: project.id, userId, role }).catch(() => undefined)
          }
        />
      )}
    </div>
  )
}

function Person({ name, email }: { name: string; email?: string }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <div className="truncate text-sm">{name}</div>
      {email && email !== name && (
        <div className="truncate text-xs text-muted-foreground">{email}</div>
      )}
    </div>
  )
}
