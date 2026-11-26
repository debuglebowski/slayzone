import { useState } from 'react'
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
import { RoleSelect } from './PeoplePicker'
import { ROLE_LABEL, useProjectPeople, type AccessRole } from './useSharing'

const RANK: Record<AccessRole, number> = { view: 0, edit: 1, manage: 2 }

/**
 * Task details → Sharing → "Add person" (T-100): one button that opens a dialog to
 * pick a person and their role on the task.
 *
 * Only the project's people (its owner and members) can be invited — the hub refuses
 * anyone else; someone outside the project is added to the project first (Project
 * Settings → Members). Under "Everyone in the project" they already see the task with
 * their project role, so an invite only gives a member MORE than that: the project
 * owner and members who already manage are not offered, and a member is offered only
 * roles above theirs. A private task can be opened to any of them.
 */
export function AddPersonButton({
  exclude,
  roles,
  projectId,
  visibility,
  creatorName,
  onAdd
}: {
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
        size="icon"
        className="shrink-0"
        aria-label="Add person"
        title="Add person"
        data-testid="task-add-person"
        onClick={() => setOpen(true)}
      >
        <UserPlus className="size-4" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md" data-testid="task-add-person-dialog">
          {open && (
            <AddPersonForm
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
  exclude,
  roles,
  projectId,
  visibility,
  creatorName,
  onAdd,
  onDone
}: {
  exclude: ReadonlySet<string>
  roles: readonly AccessRole[]
  projectId: string
  visibility: 'project' | 'private'
  creatorName: string
  onAdd: (userId: string, role: AccessRole) => Promise<unknown>
  onDone: () => void
}): React.JSX.Element {
  const { people, loading } = useProjectPeople(projectId)
  const projectRole = new Map(people.map((p) => [p.id, p.projectRole]))

  const sees = visibility === 'project'
  // The roles a task invite would actually change for this person.
  const rolesFor = (id: string): readonly AccessRole[] => {
    const pr = projectRole.get(id)
    if (pr === undefined) return []
    if (!sees) return roles
    if (pr === 'owner') return []
    return roles.filter((r) => RANK[r] > RANK[pr])
  }
  const candidates = people.filter((p) => !exclude.has(p.id) && rolesFor(p.id).length > 0)

  const [userId, setUserId] = useState('')
  const [role, setRole] = useState<AccessRole>(roles[0] ?? 'view')
  const [busy, setBusy] = useState(false)
  const offered = userId ? rolesFor(userId) : roles

  const note = (id: string): string => {
    const pr = projectRole.get(id)
    return pr === 'owner' ? 'Project owner' : pr ? ROLE_LABEL[pr] : ''
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Add a person</DialogTitle>
        <DialogDescription>
          {sees
            ? 'Everyone in the project already sees this task with their project role. Give a member more access to this task.'
            : `This task is private: only ${creatorName} and the people added here see it.`}{' '}
          Only people in the project can be added.
        </DialogDescription>
      </DialogHeader>
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="task-add-person-none">
          {sees
            ? 'Everyone in the project already has the most this task can give them.'
            : 'Everyone in the project is already in.'}{' '}
          Add more people to the project in Project Settings → Members.
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
                      {p.email} · {note(p.id)}
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
