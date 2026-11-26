import { useState, type ReactNode } from 'react'
import { Info, MoreHorizontal, Search, ShieldAlert, UserPlus } from 'lucide-react'
import type { ErasureReport } from '@slayzone/content-erasure'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  toast,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '@slayzone/ui'
import { StatusDot } from '../view/StatusDot'
import { AddHubUserDialog, type CreatedHubAccount, type HubAccountRole } from './AddHubUserDialog'
import { describeError, EraseUserDialog, UserCleanupPanel } from './HubUserErasure'

export interface ManagedHubUser {
  id: string
  name: string
  email: string
  role: HubAccountRole
  disabledAt: string | null
  createdAt: string
  /** Managed by `slayzone-hub break-glass` alone: no actions here. */
  breakGlass: boolean
}

/** What this hub lets the Users tab do (hub `describe`). */
export interface HubUserManagement {
  roleAuthority: 'idp' | 'entra-app-roles' | 'hub'
  passwordEnabled: boolean
}

interface Props {
  users: ManagedHubUser[]
  /** The signed-in admin's own account id: marked "You", and warned before self-lockout. */
  selfUserId: string | null
  management: HubUserManagement | null
  /** For "Copy sign-in details" after creating an account. */
  hubUrl?: string
  reports: ErasureReport[]
  statusUserId: string | null
  onShowReports: (userId: string | null) => void
  onPreview: (userId: string) => Promise<{ counts: ErasureReport['counts'] }>
  onCreate: (input: {
    email: string
    name?: string
    role?: HubAccountRole
  }) => Promise<CreatedHubAccount>
  onDisable: (email: string) => Promise<void>
  onEnable: (email: string) => Promise<void>
  onSetRole: (email: string, role: HubAccountRole) => Promise<void>
  onErase: (userId: string, confirmation: string) => Promise<ErasureReport>
  onRetry: (jobId: string) => Promise<ErasureReport>
  reportsLoading?: boolean
  reportsError?: boolean
}

type Filter = 'all' | 'active' | 'disabled'
/** A role change waiting for confirmation (promotions, and demoting yourself). */
type RoleChange = { user: ManagedHubUser; role: HubAccountRole }

const ROLE_SOURCE: Record<Exclude<HubUserManagement['roleAuthority'], 'hub'>, string> = {
  'entra-app-roles':
    'Roles on this hub come from Entra ID: assign or remove the SlayZone.Admin app role on the enterprise application. A change applies at the account’s next sign-in.',
  idp: 'Roles on this hub are managed by your identity provider.'
}

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

function initials(user: ManagedHubUser): string {
  const words = user.name.trim().split(/\s+/).filter(Boolean)
  const letters =
    words.length >= 2 ? `${words[0]![0]}${words[words.length - 1]![0]}` : user.name.slice(0, 2)
  return (letters || user.email.slice(0, 2)).toUpperCase()
}

/**
 * A hub's accounts: who can sign in, as what, and the admin actions on each.
 * Only administrative metadata enters this view: no titles, chats or file paths.
 */
export function HubUsersView(props: Props) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [adding, setAdding] = useState(false)
  const [disable, setDisable] = useState<ManagedHubUser | null>(null)
  const [roleChange, setRoleChange] = useState<RoleChange | null>(null)
  const [erase, setErase] = useState<{ user: ManagedHubUser; attempt: number } | null>(null)
  const [eraseOpen, setEraseOpen] = useState(false)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)

  const management = props.management
  // A hub too old to describe itself has no add / enable / role procedures either.
  const outdated = management === null
  const rolesHere = management?.roleAuthority === 'hub'
  const canAdd = management?.passwordEnabled === true
  const active = props.users.filter((u) => u.disabledAt === null)
  const disabledCount = props.users.length - active.length
  const words = query.trim().toLowerCase()
  const shown = props.users.filter(
    (u) =>
      (filter === 'all' || (filter === 'active') === (u.disabledAt === null)) &&
      (!words || `${u.name} ${u.email}`.toLowerCase().includes(words))
  )
  const cleanupUser = props.users.find((u) => u.id === props.statusUserId)

  /** Run one row action: the row shows it is busy, the outcome is a toast. */
  function act(user: ManagedHubUser, run: () => Promise<void>, done: string) {
    setPendingId(user.id)
    void run()
      .then(() => toast.success(done))
      .catch((failure) => toast.error(describeError(failure)))
      .finally(() => setPendingId(null))
  }
  /** Run a confirmed dialog action: errors stay in the dialog, success closes it. */
  function confirmIn(run: () => Promise<void>, close: () => void, done: string) {
    if (pendingId) return
    setPendingId('dialog')
    setDialogError(null)
    void run()
      .then(() => {
        close()
        toast.success(done)
      })
      .catch((failure) => setDialogError(describeError(failure)))
      .finally(() => setPendingId(null))
  }
  function requestRole(user: ManagedHubUser, role: HubAccountRole) {
    setDialogError(null)
    // Granting admin, or giving up your own: say what it means first.
    if (role === 'admin' || user.id === props.selfUserId) setRoleChange({ user, role })
    else act(user, () => props.onSetRole(user.email, role), `${user.name} is now a user`)
  }

  const filters: Array<[Filter, string, number]> = [
    ['all', 'All', props.users.length],
    ['active', 'Active', active.length],
    ['disabled', 'Disabled', disabledCount]
  ]
  const addButton = (
    <Button
      size="sm"
      disabled={!canAdd}
      onClick={() => setAdding(true)}
      data-testid="hub-user-add-open"
    >
      <UserPlus />
      Add user
    </Button>
  )

  return (
    <section className="space-y-4" aria-label="Hub users" data-testid="hub-users">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-64 max-w-full">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search name or email"
            aria-label="Search users"
            className="h-8 pl-8"
          />
        </div>
        <div role="tablist" aria-label="Filter users" className="flex rounded-md border p-0.5">
          {filters.map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={filter === key}
              onClick={() => setFilter(key)}
              className={cn(
                'rounded-sm px-2.5 py-1 text-xs transition-colors',
                filter === key
                  ? 'bg-accent font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {label} <span className="text-muted-foreground tabular-nums">{count}</span>
            </button>
          ))}
        </div>
        <div className="ml-auto">
          {canAdd ? (
            addButton
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0}>{addButton}</span>
              </TooltipTrigger>
              <TooltipContent className="max-w-64">
                {outdated
                  ? 'Update this hub to add users from here, or run `slay hub users add` on it.'
                  : 'Password sign-in is off on this hub, so accounts are made at their first SSO sign-in.'}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      {management && management.roleAuthority !== 'hub' ? (
        <p
          className="flex items-start gap-2 rounded-md border px-3 py-2 text-xs text-muted-foreground"
          data-testid="hub-users-role-source"
        >
          <Info className="mt-px size-3.5 shrink-0" />
          {ROLE_SOURCE[management.roleAuthority]}
        </p>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-2 pr-3 pl-4 font-medium">User</th>
              <th className="w-24 py-2 pr-3 font-medium">Role</th>
              <th className="w-40 py-2 pr-3 font-medium">Status</th>
              <th className="w-32 py-2 pr-3 font-medium">Added</th>
              <th className="w-12 py-2 pr-2">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {shown.map((user) => {
              const self = user.id === props.selfUserId
              const disabled = user.disabledAt !== null
              const busy = pendingId === user.id
              return (
                <tr key={user.id} data-testid={`hub-user-row-${user.email}`}>
                  <td className="py-2.5 pr-3 pl-4">
                    <div
                      className={cn('flex min-w-0 items-center gap-3', disabled && 'opacity-60')}
                    >
                      <span
                        aria-hidden
                        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground"
                      >
                        {initials(user)}
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate font-medium">{user.name}</span>
                          {self ? <Pill>You</Pill> : null}
                          {user.breakGlass ? (
                            <Pill tone="warn" title="Emergency account">
                              <ShieldAlert className="size-3" />
                              Emergency
                            </Pill>
                          ) : null}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">{user.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="py-2.5 pr-3">
                    {user.breakGlass ? (
                      <span className="text-xs text-muted-foreground">—</span>
                    ) : (
                      <Pill tone={user.role === 'admin' ? 'primary' : 'muted'}>
                        {user.role === 'admin' ? 'Admin' : 'User'}
                      </Pill>
                    )}
                  </td>
                  <td className="py-2.5 pr-3">
                    <span className="flex items-center gap-2 text-xs">
                      <StatusDot tone={disabled ? 'idle' : 'ok'} />
                      {disabled ? (
                        <span className="text-muted-foreground">
                          Disabled {formatDate(user.disabledAt!)}
                        </span>
                      ) : (
                        'Active'
                      )}
                    </span>
                  </td>
                  <td className="py-2.5 pr-3 text-xs text-muted-foreground">
                    {formatDate(user.createdAt)}
                  </td>
                  <td className="py-2.5 pr-2 text-right">
                    {user.breakGlass ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="inline-flex size-8 items-center justify-center text-muted-foreground">
                            <Info className="size-4" aria-label="Managed on the hub machine" />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-64">
                          Only <code>slayzone-hub break-glass</code> on the hub machine opens or
                          ends this account.
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      // Not modal: an item opens a dialog, and a modal menu closing
                      // under it leaves the page unclickable.
                      <DropdownMenu modal={false}>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={busy || pendingId === 'dialog'}
                            aria-label={`Actions for ${user.name}`}
                          >
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-44">
                          {disabled ? (
                            <>
                              {outdated ? null : (
                                <DropdownMenuItem
                                  onSelect={() =>
                                    act(
                                      user,
                                      () => props.onEnable(user.email),
                                      `${user.name} can sign in again`
                                    )
                                  }
                                >
                                  Enable
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem onSelect={() => props.onShowReports(user.id)}>
                                Cleanup status
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                variant="destructive"
                                onSelect={() => {
                                  setErase((last) => ({ user, attempt: (last?.attempt ?? 0) + 1 }))
                                  setEraseOpen(true)
                                }}
                              >
                                Erase all content…
                              </DropdownMenuItem>
                            </>
                          ) : (
                            <>
                              {rolesHere ? (
                                <DropdownMenuItem
                                  onSelect={() =>
                                    requestRole(user, user.role === 'admin' ? 'user' : 'admin')
                                  }
                                >
                                  {user.role === 'admin' ? 'Remove admin' : 'Make admin'}
                                </DropdownMenuItem>
                              ) : null}
                              {rolesHere ? <DropdownMenuSeparator /> : null}
                              <DropdownMenuItem
                                variant="destructive"
                                onSelect={() => {
                                  setDialogError(null)
                                  setDisable(user)
                                }}
                              >
                                Disable…
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </td>
                </tr>
              )
            })}
            {shown.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  {props.users.length === 0
                    ? 'No users.'
                    : words
                      ? `No users match “${query.trim()}”.`
                      : filter === 'disabled'
                        ? 'No disabled users.'
                        : 'No active users.'}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {cleanupUser ? (
        <UserCleanupPanel
          user={cleanupUser}
          reports={props.reports}
          loading={props.reportsLoading}
          failed={props.reportsError}
          onRetry={props.onRetry}
          onRefresh={() => props.onShowReports(cleanupUser.id)}
          onClose={() => props.onShowReports(null)}
        />
      ) : null}

      <AddHubUserDialog
        open={adding}
        onOpenChange={setAdding}
        canChooseRole={rolesHere}
        hubUrl={props.hubUrl}
        onCreate={props.onCreate}
      />

      <AlertDialog
        open={disable !== null}
        onOpenChange={(open) => {
          if (!open && pendingId !== 'dialog') setDisable(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disable {disable?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This revokes access to this hub and disconnects their computers. Their content is
              kept, and you can enable the account again.
              {disable?.id === props.selfUserId ? ' You will be signed out of this hub.' : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {dialogError ? (
            <p role="alert" className="text-sm text-destructive">
              {dialogError}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pendingId === 'dialog'}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pendingId === 'dialog'}
              onClick={(event) => {
                event.preventDefault()
                const target = disable
                if (!target) return
                confirmIn(
                  () => props.onDisable(target.email),
                  () => setDisable(null),
                  `${target.name} is disabled`
                )
              }}
            >
              {pendingId === 'dialog' ? 'Disabling…' : 'Disable user'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={roleChange !== null}
        onOpenChange={(open) => {
          if (!open && pendingId !== 'dialog') setRoleChange(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {roleChange?.role === 'admin'
                ? `Make ${roleChange.user.name} an admin?`
                : 'Remove your own admin access?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {roleChange?.role === 'admin'
                ? 'Admins can add, disable and erase accounts, and change this hub’s settings.'
                : 'You will no longer be able to manage accounts on this hub. Another admin can give it back.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {dialogError ? (
            <p role="alert" className="text-sm text-destructive">
              {dialogError}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pendingId === 'dialog'}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pendingId === 'dialog'}
              onClick={(event) => {
                event.preventDefault()
                const change = roleChange
                if (!change) return
                confirmIn(
                  () => props.onSetRole(change.user.email, change.role),
                  () => setRoleChange(null),
                  `${change.user.name} is now ${change.role === 'admin' ? 'an admin' : 'a user'}`
                )
              }}
            >
              {roleChange?.role === 'admin' ? 'Make admin' : 'Remove admin'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <EraseUserDialog
        target={erase}
        open={eraseOpen}
        onClose={() => setEraseOpen(false)}
        onPreview={props.onPreview}
        onErase={props.onErase}
        onErased={(userId) => {
          setEraseOpen(false)
          props.onShowReports(userId)
        }}
      />
    </section>
  )
}

function Pill({
  tone = 'muted',
  title,
  children
}: {
  tone?: 'muted' | 'primary' | 'warn'
  title?: string
  children: ReactNode
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium leading-none',
        tone === 'primary' && 'bg-primary/10 text-primary',
        tone === 'muted' && 'bg-muted text-muted-foreground',
        tone === 'warn' && 'bg-destructive/10 text-destructive'
      )}
    >
      {children}
    </span>
  )
}
