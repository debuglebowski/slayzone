import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { UserPlus } from 'lucide-react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@slayzone/ui'
import { useTRPC } from '../trpc'
import { RoleSelect } from './PeoplePicker'
import { ROLE_LABEL, type AccessRole } from './useSharing'

interface Person {
  id: string
  name: string
  email: string
}

const RANK: Record<AccessRole, number> = { view: 0, edit: 1, manage: 2 }

/**
 * Task details → Sharing → "Add person" (T-100): one button that opens a dialog to
 * pick a person and their role on the task.
 *
 * Under "Everyone in the project" the project's people already see the task with
 * their project role, so a task invite only matters for someone OUTSIDE the project,
 * or to give a member MORE than their project role: the project owner and members
 * who already manage are not offered, and a member is offered only roles above theirs.
 */
export function AddPersonButton({
  people,
  exclude,
  roles,
  projectId,
  visibility,
  creatorName,
  onAdd
}: {
  people: readonly Person[]
  /** Already invited (and the creator): not offered again. */
  exclude: ReadonlySet<string>
  roles: readonly AccessRole[]
  projectId: string
  visibility: 'project' | 'private'
  creatorName: string
  onAdd: (userId: string, role: AccessRole) => Promise<unknown>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="w-full"
        data-testid="task-add-person"
        onClick={() => setOpen(true)}
      >
        <UserPlus className="size-4" />
        Add person
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md" data-testid="task-add-person-dialog">
          {open && (
            <AddPersonForm
              people={people}
              exclude={exclude}
              roles={roles}
              projectId={projectId}
              visibility={visibility}
              creatorName={creatorName}
              onAdd={onAdd}
              onDone={() => setOpen(false)}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

function AddPersonForm({
  people,
  exclude,
  roles,
  projectId,
  visibility,
  creatorName,
  onAdd,
  onDone
}: {
  people: readonly Person[]
  exclude: ReadonlySet<string>
  roles: readonly AccessRole[]
  projectId: string
  visibility: 'project' | 'private'
  creatorName: string
  onAdd: (userId: string, role: AccessRole) => Promise<unknown>
  onDone: () => void
}): React.JSX.Element {
  const trpc = useTRPC()
  // Who is in the project, and as what. Refused (a non-member managing this task by
  // invite): nobody is annotated, everyone is offered every role.
  const membersQuery = useQuery({
    ...trpc.sharing.projectMembers.queryOptions({ projectId }),
    retry: false
  })
  const projectRole = new Map<string, AccessRole | 'owner'>()
  for (const m of membersQuery.data?.members ?? []) projectRole.set(m.userId, m.role)
  const ownerId = membersQuery.data?.ownerUserId
  if (ownerId) projectRole.set(ownerId, 'owner')

  const sees = visibility === 'project'
  // The roles a task invite would actually change for this person.
  const rolesFor = (id: string): readonly AccessRole[] => {
    const pr = projectRole.get(id)
    if (!sees || pr === undefined) return roles
    if (pr === 'owner') return []
    return roles.filter((r) => RANK[r] > RANK[pr])
  }
  const candidates = people.filter((p) => !exclude.has(p.id) && rolesFor(p.id).length > 0)

  const [userId, setUserId] = useState('')
  const [role, setRole] = useState<AccessRole>(roles[0] ?? 'view')
  const [busy, setBusy] = useState(false)
  const offered = userId ? rolesFor(userId) : roles

  const note = (id: string): string | null => {
    const pr = projectRole.get(id)
    if (pr === undefined) return null
    return pr === 'owner' ? 'Project owner' : `In the project · ${ROLE_LABEL[pr]}`
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Add a person</DialogTitle>
        <DialogDescription>
          {sees
            ? 'Everyone in the project already sees this task with their project role. Add someone from outside the project, or give a member more access to this task.'
            : `This task is private: only ${creatorName} and the people added here see it.`}
        </DialogDescription>
      </DialogHeader>
      {candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="task-add-person-none">
          {sees
            ? 'Everyone on this hub already has the most this task can give them.'
            : 'Everyone on this hub is already in.'}
        </p>
      ) : (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Person</Label>
            <Select
              value={userId}
              onValueChange={(id) => {
                setUserId(id)
                const next = rolesFor(id)
                if (!next.includes(role)) setRole(next[0] ?? role)
              }}
            >
              <SelectTrigger className="w-full" data-testid="task-add-person-person">
                <SelectValue placeholder="Choose a person…" />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name || p.email}
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      {note(p.id) ?? p.email}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Access to this task</Label>
            <RoleSelect
              value={role}
              roles={offered}
              onChange={setRole}
              testId="task-add-person-role"
              className="w-full"
            />
          </div>
        </div>
      )}
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button
          disabled={!userId || busy}
          data-testid="task-add-person-add"
          onClick={() => {
            setBusy(true)
            void onAdd(userId, role)
              .then(onDone, () => undefined) // the mutation toasts; stay open to retry
              .finally(() => setBusy(false))
          }}
        >
          Add
        </Button>
      </DialogFooter>
    </>
  )
}
