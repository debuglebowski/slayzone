import { useState } from 'react'
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@slayzone/ui'
import { ROLE_HINT, ROLE_LABEL, type AccessRole } from './useSharing'

interface Person {
  id: string
  name: string
  email: string
}

/**
 * Pick a person and a role, then Add. `exclude`: people already in (and the owner),
 * who are not offered again. `emptyText`: shown when nobody is left to offer.
 */
export function PeoplePicker({
  people,
  exclude,
  roles,
  onAdd,
  testId,
  emptyText = 'Everyone on this hub is already in.'
}: {
  people: readonly Person[]
  exclude: ReadonlySet<string>
  roles: readonly AccessRole[]
  onAdd: (userId: string, role: AccessRole) => Promise<unknown>
  testId: string
  emptyText?: string
}): React.JSX.Element {
  const candidates = people.filter((p) => !exclude.has(p.id))
  const [userId, setUserId] = useState<string>('')
  const [role, setRole] = useState<AccessRole>(roles[0] ?? 'view')
  const [busy, setBusy] = useState(false)
  if (candidates.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid={`${testId}-none`}>
        {emptyText}
      </p>
    )
  }
  return (
    <div className="flex items-center gap-2" data-testid={testId}>
      <Select value={userId} onValueChange={setUserId}>
        <SelectTrigger className="min-w-0 flex-1" data-testid={`${testId}-person`}>
          <SelectValue placeholder="Add a person…" />
        </SelectTrigger>
        <SelectContent>
          {candidates.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name || p.email}
              <span className="ml-1.5 text-xs text-muted-foreground">{p.email}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <RoleSelect value={role} roles={roles} onChange={setRole} testId={`${testId}-role`} />
      <Button
        size="sm"
        disabled={!userId || busy}
        data-testid={`${testId}-add`}
        onClick={() => {
          setBusy(true)
          void onAdd(userId, role)
            .then(() => setUserId(''))
            .finally(() => setBusy(false))
        }}
      >
        Add
      </Button>
    </div>
  )
}

export function RoleSelect({
  value,
  roles,
  onChange,
  disabled,
  testId,
  className = 'w-[9.5rem] shrink-0'
}: {
  value: AccessRole
  roles: readonly AccessRole[]
  onChange: (role: AccessRole) => void
  disabled?: boolean
  testId?: string
  className?: string
}): React.JSX.Element {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as AccessRole)} disabled={disabled}>
      <SelectTrigger className={className} data-testid={testId}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {roles.map((r) => (
          <SelectItem key={r} value={r}>
            {ROLE_LABEL[r]}
            <span className="ml-1.5 text-xs text-muted-foreground">{ROLE_HINT[r]}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
