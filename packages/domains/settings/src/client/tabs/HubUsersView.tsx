import { useRef, useState } from 'react'
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
  Input,
  Label
} from '@slayzone/ui'

export interface ManagedHubUser {
  id: string
  name: string
  email: string
  disabledAt: string | null
}
interface Props {
  users: ManagedHubUser[]
  reports: ErasureReport[]
  statusUserId: string | null
  onShowReports: (userId: string) => void
  onPreview: (userId: string) => Promise<{ counts: ErasureReport['counts'] }>
  onDisable: (email: string) => Promise<void>
  onErase: (userId: string, confirmation: string) => Promise<ErasureReport>
  onRetry: (jobId: string) => Promise<ErasureReport>
  reportsLoading?: boolean
  reportsError?: boolean
}
const describeError = (error: unknown) =>
  error instanceof Error ? error.message : 'The operation failed. Please retry.'

/** Only administrative metadata enters this view: no titles, chats or file paths. */
export function HubUsersView(props: Props) {
  const [disable, setDisable] = useState<ManagedHubUser | null>(null)
  const [erase, setErase] = useState<ManagedHubUser | null>(null)
  const [confirmation, setConfirmation] = useState('')
  const [counts, setCounts] = useState<ErasureReport['counts'] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const previewRequest = useRef(0)

  function openErase(user: ManagedHubUser) {
    const request = ++previewRequest.current
    setErase(user)
    setConfirmation('')
    setCounts(null)
    setError(null)
    void props
      .onPreview(user.id)
      .then((result) => {
        if (previewRequest.current === request) setCounts(result.counts)
      })
      .catch((failure) => {
        if (previewRequest.current === request) setError(describeError(failure))
      })
  }
  function closeErase() {
    if (busy) return
    previewRequest.current++
    setErase(null)
    setConfirmation('')
    setCounts(null)
    setError(null)
  }
  function confirmDisable() {
    if (!disable || busy) return
    setBusy(true)
    setError(null)
    void props
      .onDisable(disable.email)
      .then(() => setDisable(null))
      .catch((failure) => setError(describeError(failure)))
      .finally(() => setBusy(false))
  }
  function confirmErase() {
    if (
      !erase ||
      busy ||
      !counts ||
      confirmation.trim().toLowerCase() !== erase.email.toLowerCase()
    )
      return
    const userId = erase.id
    setBusy(true)
    setError(null)
    void props
      .onErase(userId, confirmation)
      .then(() => {
        props.onShowReports(userId)
        previewRequest.current++
        setErase(null)
        setConfirmation('')
        setCounts(null)
      })
      .catch((failure) => setError(describeError(failure)))
      .finally(() => setBusy(false))
  }
  const reports = new Map<string, ErasureReport>()
  for (const report of props.reports) reports.set(report.id, report)
  const selected = props.users.find((user) => user.id === props.statusUserId)
  return (
    <section className="mt-3 space-y-3 border-t border-border pt-3" aria-label="Hub users">
      <h3 className="text-sm font-medium">Users</h3>
      <div className="space-y-2">
        {props.users.map((user) => (
          <div key={user.id} className="flex flex-wrap items-center gap-2 text-sm">
            <div className="min-w-0 flex-1">
              <span className="font-medium">{user.name}</span>
              <span className="ml-2 break-all text-xs text-muted-foreground">{user.email}</span>
            </div>
            <span className="text-xs text-muted-foreground">
              {user.disabledAt ? 'Disabled' : 'Active'}
            </span>
            {user.disabledAt ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  aria-label={`View cleanup for ${user.name}`}
                  onClick={() => {
                    setError(null)
                    props.onShowReports(user.id)
                  }}
                >
                  Cleanup status
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive"
                  disabled={busy}
                  aria-label={`Erase content for ${user.name}`}
                  onClick={() => openErase(user)}
                >
                  Erase all content
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                aria-label={`Disable ${user.name}`}
                onClick={() => {
                  setError(null)
                  setDisable(user)
                }}
              >
                Disable
              </Button>
            )}
          </div>
        ))}
        {props.users.length === 0 ? (
          <p className="text-xs text-muted-foreground">No users.</p>
        ) : null}
      </div>
      {error && !disable && !erase ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {selected ? (
        <div className="space-y-2 text-sm" aria-live="polite">
          <h4 className="font-medium">Cleanup for {selected.name}</h4>
          {props.reportsError ? (
            <p role="alert" className="text-destructive">
              Could not load cleanup status. Try Cleanup status again.
            </p>
          ) : props.reportsLoading ? (
            <p className="text-muted-foreground">Loading cleanup status…</p>
          ) : reports.size === 0 ? (
            <p className="text-muted-foreground">No erasure operations recorded.</p>
          ) : null}
          {[...reports.values()].map((report) => (
            <div key={report.id} className="space-y-1 border-l-2 border-border pl-3">
              <p>
                {report.state === 'complete'
                  ? 'SlayZone content erased.'
                  : 'Some data has not been deleted yet.'}
              </p>
              {report.computers
                .filter((computer) => !computer.deleted)
                .map((computer) => (
                  <p key={computer.id}>
                    Data on <strong>{computer.name}</strong> has not been deleted yet.
                  </p>
                ))}
              {report.computers
                .filter((c) => c.verifiedBy === 'operator')
                .map((c) => (
                  <p key={`operator-${c.id}`} className="text-xs text-muted-foreground">
                    Cleanup on {c.name} was confirmed by an operator.
                  </p>
                ))}
              {report.failures.length > 0 ? (
                <p className="text-destructive">
                  {report.failures.some(
                    (code) =>
                      code === 'LEGACY_FILES_NEED_OWNERSHIP_REVIEW' ||
                      code === 'LEGACY_DIAGNOSTICS_NEED_OWNERSHIP_REVIEW'
                  )
                    ? 'Old files have no recorded owner. An operator must check them locally before erasure can be confirmed.'
                    : report.failures.includes('BLOB_CLEANUP_WAITING_FOR_BACKUP')
                      ? 'File cleanup will continue when the running backup finishes.'
                      : report.failures.includes('WORKTREE_COMPUTER_GONE')
                        ? 'A worktree is on a computer that was removed or revoked. It will not be retried; an operator must confirm its removal locally.'
                        : 'Some data could not be deleted. Cleanup will retry.'}
                </p>
              ) : null}
              {report.retainedSharedBlobs > 0 ? (
                <p className="text-xs text-muted-foreground">
                  Files needed by other content were kept.
                </p>
              ) : null}
              {report.retainedBackupBlobs > 0 ? (
                <p className="text-xs text-muted-foreground">
                  Existing backups remain until their normal expiry.
                </p>
              ) : null}
              {report.state === 'incomplete' ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true)
                    setError(null)
                    void props
                      .onRetry(report.id)
                      .then(() => {
                        props.onShowReports(selected.id)
                      })
                      .catch((failure) => setError(describeError(failure)))
                      .finally(() => setBusy(false))
                  }}
                >
                  Retry cleanup
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      <AlertDialog
        open={disable !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setDisable(null)
            setError(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disable {disable?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This revokes access to this hub and disconnects their computers. Their content is
              kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault()
                confirmDisable()
              }}
            >
              {busy ? 'Disabling…' : 'Disable user'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={erase !== null}
        onOpenChange={(open) => {
          if (!open) closeErase()
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Erase all content for {erase?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Includes archived projects and tasks, chats, files and every saved version. This
              cannot be undone. Their account stays disabled.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {counts ? (
            <p className="text-sm">
              {counts.projects} {counts.projects === 1 ? 'project' : 'projects'} · {counts.tasks}{' '}
              tasks · {counts.artifacts} files · {counts.versions} saved versions
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {error ? 'Could not check content counts.' : 'Checking content counts…'}
            </p>
          )}
          <div className="space-y-2">
            <Label htmlFor="erase-user-email">Confirm user email</Label>
            <Input
              id="erase-user-email"
              type="email"
              value={confirmation}
              placeholder={erase?.email}
              autoComplete="off"
              disabled={busy}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground"
              disabled={
                busy || !counts || confirmation.trim().toLowerCase() !== erase?.email.toLowerCase()
              }
              onClick={(event) => {
                event.preventDefault()
                confirmErase()
              }}
            >
              {busy ? 'Erasing…' : 'Erase all content'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
