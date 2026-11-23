import { ArrowRight, Loader2, Terminal, X } from 'lucide-react'
import { Button, toast } from '@slayzone/ui'

export interface OutdatedCliStatus {
  path?: string
  version?: string | null
  expectedVersion?: string | null
  appManaged?: boolean
}

export interface CliUpdateActions {
  update: () => Promise<{ ok: boolean; error?: string; pathNotInPATH?: boolean }>
  dismiss: () => void
}

type Phase = { kind: 'available' } | { kind: 'updating' } | { kind: 'failed'; error: string }

const TOAST_ID = 'cli-update-notice'

/**
 * Non-blocking: a stale `slay` still works for most commands, so it gets a toast,
 * not a modal. An app-managed install (the app's own symlink/shim) can be refreshed
 * in place; anything else (npm global, a copy elsewhere on PATH) belongs to whatever
 * put it there, so the notice says where it is instead of touching it.
 *
 * Each phase re-renders the same toast id; the component is stateless so a phase
 * change never depends on sonner preserving React state across updates.
 */
export function showCliUpdateNotice(status: OutdatedCliStatus, actions: CliUpdateActions): void {
  const show = (phase: Phase) =>
    toast.custom(
      () => (
        <CliUpdateToast
          status={status}
          phase={phase}
          onUpdate={runUpdate}
          onSkip={() => {
            actions.dismiss()
            toast.dismiss(TOAST_ID)
          }}
          onClose={() => toast.dismiss(TOAST_ID)}
        />
      ),
      // Waiting on the user: auto-hide. Busy or failed: stay until resolved/closed.
      { id: TOAST_ID, duration: phase.kind === 'available' ? 15000 : Infinity }
    )

  const runUpdate = () => {
    show({ kind: 'updating' })
    void actions.update().then(
      (r) => {
        if (!r.ok) {
          show({ kind: 'failed', error: r.error ?? 'Updating the slay CLI failed.' })
          return
        }
        toast.dismiss(TOAST_ID)
        toast.success(`slay CLI updated to v${status.expectedVersion}`, {
          description: r.pathNotInPATH
            ? "Its install directory is not on your PATH — add it to run 'slay' from any terminal."
            : undefined
        })
      },
      (err: unknown) =>
        show({
          kind: 'failed',
          error: err instanceof Error ? err.message : 'Updating the slay CLI failed.'
        })
    )
  }

  show({ kind: 'available' })
}

export function CliUpdateToast({
  status,
  phase,
  onUpdate,
  onSkip,
  onClose
}: {
  status: OutdatedCliStatus
  phase: Phase
  onUpdate: () => void
  onSkip: () => void
  onClose: () => void
}): React.JSX.Element {
  const busy = phase.kind === 'updating'
  return (
    <div
      data-testid="cli-update-notice"
      className="bg-popover text-popover-foreground border-border w-[var(--width,356px)] rounded-xl border p-4 text-sm shadow-2xl"
    >
      <div className="flex gap-3">
        <div className="bg-primary/10 flex size-8 shrink-0 items-center justify-center rounded-lg">
          <Terminal className="text-primary size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-medium leading-5">slay CLI update available</div>
          <div className="text-muted-foreground mt-0.5 flex items-center gap-1.5 font-mono text-xs">
            <span>v{status.version}</span>
            <ArrowRight className="size-3" />
            <span className="text-foreground">v{status.expectedVersion}</span>
          </div>
          {!status.appManaged && (
            <div className="mt-2 text-xs">
              <p className="text-muted-foreground">Installed by another tool — update it there:</p>
              <code className="bg-muted text-foreground mt-1 block break-all rounded-md px-2 py-1 font-mono">
                {status.path}
              </code>
            </div>
          )}
          {phase.kind === 'failed' && (
            <p className="text-destructive mt-2 whitespace-pre-wrap text-xs leading-relaxed">
              {phase.error}
            </p>
          )}
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground -mr-1 -mt-1 size-6 shrink-0 rounded-md p-1 transition-colors"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground"
          onClick={onSkip}
          disabled={busy}
        >
          Skip this version
        </Button>
        {status.appManaged && (
          <Button size="sm" onClick={onUpdate} disabled={busy}>
            {busy && <Loader2 className="animate-spin" />}
            {busy ? 'Updating…' : phase.kind === 'failed' ? 'Retry' : 'Update'}
          </Button>
        )}
      </div>
    </div>
  )
}
