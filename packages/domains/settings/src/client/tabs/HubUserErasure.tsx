import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
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
  Label,
  useStableCallback
} from '@slayzone/ui'

/** The account an erasure dialog or cleanup panel is about. */
export interface ErasureTarget {
  id: string
  name: string
  email: string
}

export const describeError = (error: unknown) =>
  error instanceof Error ? error.message : 'The operation failed. Please retry.'

/** A disabled user's erasure operations: what is still left, and a retry. */
export function UserCleanupPanel({
  user,
  reports,
  loading,
  failed,
  onRetry,
  onRefresh,
  onClose
}: {
  user: ErasureTarget
  reports: ErasureReport[]
  loading?: boolean
  failed?: boolean
  onRetry: (jobId: string) => Promise<ErasureReport>
  onRefresh: () => void
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const byId = new Map<string, ErasureReport>()
  for (const report of reports) byId.set(report.id, report)
  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-card px-4 py-3 text-sm"
      aria-live="polite"
      aria-label={`Cleanup for ${user.name}`}
      data-testid="hub-user-cleanup"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium">Cleanup for {user.name}</h3>
        <Button variant="ghost" size="icon-sm" aria-label="Close cleanup" onClick={onClose}>
          <X />
        </Button>
      </div>
      {failed ? (
        <p role="alert" className="text-destructive">
          Could not load cleanup status. Try Cleanup status again.
        </p>
      ) : loading ? (
        <p className="text-muted-foreground">Loading cleanup status…</p>
      ) : byId.size === 0 ? (
        <p className="text-muted-foreground">No erasure operations recorded.</p>
      ) : null}
      {[...byId.values()].map((report) => (
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
                void onRetry(report.id)
                  .then(onRefresh)
                  .catch((failure) => setError(describeError(failure)))
                  .finally(() => setBusy(false))
              }}
            >
              Retry cleanup
            </Button>
          ) : null}
        </div>
      ))}
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  )
}

/**
 * Erase everything a DISABLED user owns: counts first, then the user's email typed
 * back, then the hub's erasure job. The account itself stays (disabled).
 *
 * `target` outlives `open` so the closing animation still names the user; its
 * `attempt` remounts the body, so every opening starts from empty state.
 */
export function EraseUserDialog({
  target,
  open,
  onClose,
  onPreview,
  onErase,
  onErased
}: {
  target: { user: ErasureTarget; attempt: number } | null
  open: boolean
  onClose: () => void
  onPreview: (userId: string) => Promise<{ counts: ErasureReport['counts'] }>
  onErase: (userId: string, confirmation: string) => Promise<ErasureReport>
  onErased: (userId: string) => void
}) {
  const [busy, setBusy] = useState(false)
  return (
    <AlertDialog
      open={open && target !== null}
      onOpenChange={(next) => {
        if (!next && !busy) onClose()
      }}
    >
      <AlertDialogContent>
        {target ? (
          <EraseUserBody
            key={target.attempt}
            user={target.user}
            busy={busy}
            setBusy={setBusy}
            onPreview={onPreview}
            onErase={onErase}
            onErased={onErased}
          />
        ) : null}
      </AlertDialogContent>
    </AlertDialog>
  )
}

function EraseUserBody({
  user,
  busy,
  setBusy,
  onPreview,
  onErase,
  onErased
}: {
  user: ErasureTarget
  busy: boolean
  setBusy: (busy: boolean) => void
  onPreview: (userId: string) => Promise<{ counts: ErasureReport['counts'] }>
  onErase: (userId: string, confirmation: string) => Promise<ErasureReport>
  onErased: (userId: string) => void
}) {
  const [confirmation, setConfirmation] = useState('')
  const [counts, setCounts] = useState<ErasureReport['counts'] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const preview = useStableCallback(onPreview)
  const userId = user.id

  // Counts once per opening (this body is keyed by it); an answer after close is dropped.
  useEffect(() => {
    let live = true
    void preview(userId)
      .then((result) => {
        if (live) setCounts(result.counts)
      })
      .catch((failure) => {
        if (live) setError(describeError(failure))
      })
    return () => {
      live = false
    }
  }, [userId, preview])

  const matches = confirmation.trim().toLowerCase() === user.email.toLowerCase()
  function confirm() {
    if (busy || !counts || !matches) return
    setBusy(true)
    setError(null)
    void onErase(userId, confirmation)
      .then(() => onErased(userId))
      .catch((failure) => setError(describeError(failure)))
      .finally(() => setBusy(false))
  }
  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>Erase all content for {user.name}?</AlertDialogTitle>
        <AlertDialogDescription>
          Includes archived projects and tasks, chats, files and every saved version. This cannot be
          undone. Their account stays disabled.
        </AlertDialogDescription>
      </AlertDialogHeader>
      {counts ? (
        <p className="text-sm">
          {counts.projects} {counts.projects === 1 ? 'project' : 'projects'} · {counts.tasks} tasks
          · {counts.artifacts} files · {counts.versions} saved versions
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
          placeholder={user.email}
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
          disabled={busy || !counts || !matches}
          onClick={(event) => {
            event.preventDefault()
            confirm()
          }}
        >
          {busy ? 'Erasing…' : 'Erase all content'}
        </AlertDialogAction>
      </AlertDialogFooter>
    </>
  )
}
