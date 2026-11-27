import { useState } from 'react'
import { Check, Copy, KeyRound, Loader2 } from 'lucide-react'
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  safeClipboardWriteText
} from '@slayzone/ui'

export type HubAccountRole = 'admin' | 'user'

export interface CreatedHubAccount {
  email: string
  name: string
  role: HubAccountRole
  /** Shown once: only its hash is stored. */
  password: string
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** False where roles come from Entra or an IdP: the hub refuses any role in `add`. */
  canChooseRole: boolean
  /** The hub's address, for "Copy sign-in details". Absent: password only. */
  hubUrl?: string
  onCreate: (input: {
    email: string
    name?: string
    role?: HubAccountRole
  }) => Promise<CreatedHubAccount>
}

const describeError = (error: unknown) =>
  error instanceof Error ? error.message : 'Could not create the account. Please retry.'

/**
 * Add a password account. The hub generates the password and returns it once, so
 * the dialog's second step is handing it over: copy, then Done.
 */
export function AddHubUserDialog({ open, onOpenChange, canChooseRole, hubUrl, onCreate }: Props) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<HubAccountRole>('user')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<CreatedHubAccount | null>(null)
  const [copied, setCopied] = useState<'password' | 'details' | null>(null)

  function reset() {
    setEmail('')
    setName('')
    setRole('user')
    setError(null)
    setCreated(null)
    setCopied(null)
  }
  function change(next: boolean) {
    if (busy) return
    onOpenChange(next)
    if (!next) reset()
  }
  const trimmed = email.trim()
  const plausible = trimmed.length > 2 && /^[^\s@]+@[^\s@]+$/.test(trimmed)
  function submit() {
    if (!plausible || busy) return
    setBusy(true)
    setError(null)
    void onCreate({
      email: trimmed,
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(canChooseRole ? { role } : {})
    })
      .then(setCreated)
      .catch((failure) => setError(describeError(failure)))
      .finally(() => setBusy(false))
  }
  function copy(kind: 'password' | 'details', text: string) {
    void safeClipboardWriteText(text).then(() => setCopied(kind))
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent className="sm:max-w-md" data-testid="hub-user-add-dialog">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Account created</DialogTitle>
              <DialogDescription>
                Give {created.name} this password. They can sign in with it on this hub.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-y-1 text-sm">
                <span className="text-muted-foreground">Email</span>
                <span className="truncate">{created.email}</span>
                <span className="text-muted-foreground">Role</span>
                <span>{created.role === 'admin' ? 'Admin' : 'User'}</span>
              </div>
              <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
                <KeyRound className="size-4 shrink-0 text-muted-foreground" />
                <code
                  className="min-w-0 flex-1 truncate font-mono text-sm select-all"
                  data-testid="hub-user-created-password"
                >
                  {created.password}
                </code>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => copy('password', created.password)}
                  aria-label="Copy password"
                >
                  {copied === 'password' ? <Check /> : <Copy />}
                  {copied === 'password' ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                This password is shown once and cannot be recovered.
              </p>
            </div>
            <DialogFooter>
              {hubUrl ? (
                <Button
                  variant="outline"
                  onClick={() =>
                    copy(
                      'details',
                      `Hub: ${hubUrl}\nEmail: ${created.email}\nPassword: ${created.password}`
                    )
                  }
                >
                  {copied === 'details' ? <Check /> : <Copy />}
                  {copied === 'details' ? 'Copied' : 'Copy sign-in details'}
                </Button>
              ) : null}
              <Button onClick={() => change(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form
            className="contents"
            onSubmit={(event) => {
              event.preventDefault()
              submit()
            }}
          >
            <DialogHeader>
              <DialogTitle>Add user</DialogTitle>
              <DialogDescription>
                The hub generates a password, shown once, for you to pass on.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="hub-user-email">Email</Label>
                <Input
                  id="hub-user-email"
                  type="email"
                  value={email}
                  autoFocus
                  autoComplete="off"
                  placeholder="name@company.com"
                  disabled={busy}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="hub-user-name">
                  Name <span className="font-normal text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="hub-user-name"
                  value={name}
                  autoComplete="off"
                  placeholder={trimmed.includes('@') ? trimmed.split('@')[0] : 'Display name'}
                  disabled={busy}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              {canChooseRole ? (
                <div className="space-y-2">
                  <Label id="hub-user-role">Role</Label>
                  <div
                    role="radiogroup"
                    aria-labelledby="hub-user-role"
                    className="grid grid-cols-2 gap-2"
                  >
                    {(
                      [
                        ['user', 'User', 'Works in projects shared with them'],
                        ['admin', 'Admin', 'Also manages accounts and hub settings']
                      ] as const
                    ).map(([value, label, hint]) => (
                      <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={role === value}
                        disabled={busy}
                        onClick={() => setRole(value)}
                        className={cn(
                          'rounded-md border px-3 py-2 text-left transition-colors',
                          role === value
                            ? 'border-primary bg-primary/5'
                            : 'border-border hover:bg-accent/50'
                        )}
                      >
                        <div className="text-sm font-medium">{label}</div>
                        <div className="text-xs text-muted-foreground">{hint}</div>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => change(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!plausible || busy}>
                {busy ? <Loader2 className="animate-spin" /> : null}
                {busy ? 'Creating…' : 'Create account'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
