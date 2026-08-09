import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { electronBootstrap } from '@slayzone/transport/client'
import { isLoopbackRunnerUrl } from '@slayzone/platform/hub-addr'
import { AlertTriangle, Copy } from 'lucide-react'
import {
  Button,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  toast
} from '@slayzone/ui'
import { RunnerRootsDialog, type RootsTarget } from './RunnerRootsDialog'

/**
 * The runner actions that must exist ONCE, not once per hub.
 *
 * Runners are listed inside their hub (a runner belongs to exactly one hub, fixed
 * at mint time), so the list itself is per-hub — see `HubCard`. But three
 * things are not: the minted-token modal, the restart-local-runner confirm, and
 * the revoke confirm. Each is a single dialog instance driven by whichever hub's
 * block asked for it.
 *
 * A context rather than props because the blocks are nested two layers down inside
 * the hub table, and drilling six handlers through it (which is what the flat
 * Runners table used to do) puts dialog state in a component that has no business
 * holding it.
 *
 * WHAT IS *NOT* HERE: mint and revoke themselves. Those are hub-scoped mutations
 * that live inside the block, inside that hub's `<HubScope>`, so they are bound to
 * the right hub by construction. This provider only paints their confirmations and
 * results.
 */

/** A minted token plus where it points, so the dialog can warn about loopback. */
export type MintedToken = {
  token: string
  hubLabel: string
  hubUrl: string | undefined
}

/** A revoke awaiting confirmation — `revoke` is the block's hub-bound thunk. */
export type RevokeTarget = {
  id: string
  name: string
  revoke: () => Promise<void>
}

export interface RunnerActionsValue {
  /** Show the one-time enrollment token a block just minted. */
  showMintedToken: (minted: MintedToken) => void
  /** Ask for confirmation before revoking; the target carries its own thunk. */
  requestRevoke: (target: RevokeTarget) => void
  /** Edit a runner's filesystem path-jail; the target carries hub-bound thunks. */
  requestEditRoots: (target: RootsTarget) => void
  /** Confirm-gated restart of the app's own supervised runner. */
  requestRestart: () => void
  /** Start a local runner that never came up. No confirm — nothing is running. */
  requestStart: () => void
  /** True while a restart/start is in flight. */
  restarting: boolean
  /**
   * Bumped after a restart/start settles, so a block can refetch its list.
   * `runners.list` does not poll, and the runner re-dials asynchronously after the
   * spawn returns — without this the table would sit on "Disconnected".
   */
  runnerRevision: number
}

const RunnerActionsContext = createContext<RunnerActionsValue | null>(null)

export function useRunnerActions(): RunnerActionsValue {
  const value = useContext(RunnerActionsContext)
  if (!value) throw new Error('useRunnerActions must be used inside <RunnerActionsProvider>')
  return value
}

/**
 * How long to wait before the second post-restart refetch. The spawn returns as
 * soon as the process exists; enrolling + reporting connected happens after.
 */
const RECONNECT_SETTLE_MS = 2000

export function RunnerActionsProvider({ children }: { children: ReactNode }) {
  const [minted, setMinted] = useState<MintedToken | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<RevokeTarget | null>(null)
  const [rootsTarget, setRootsTarget] = useState<RootsTarget | null>(null)
  const [restartOpen, setRestartOpen] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [runnerRevision, setRunnerRevision] = useState(0)

  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current)
    },
    []
  )

  /**
   * Restart (or first-start) the app's own supervised runner.
   *
   * `electronBootstrap` rather than tRPC on purpose: the runner is a child of the
   * MAIN process, not of the hub. The hub can see the runner's registry row but
   * has no handle on the process, so only the desktop bridge can cycle it — and on
   * the Chromium fork, which does not spawn it, the shim answers "not supported"
   * and this surfaces as an ordinary error toast.
   */
  const runRestart = useCallback(async (): Promise<void> => {
    setRestarting(true)
    try {
      const result = await electronBootstrap.restartLocalRunner()
      if (result.ok) toast.success('Local runner restarted')
      else toast.error(`Restart failed: ${result.error ?? 'unknown error'}`)
    } catch (err) {
      toast.error(`Restart failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setRestarting(false)
      setRunnerRevision((r) => r + 1)
      if (settleTimer.current) clearTimeout(settleTimer.current)
      settleTimer.current = setTimeout(() => setRunnerRevision((r) => r + 1), RECONNECT_SETTLE_MS)
    }
  }, [])

  const showMintedToken = useCallback((next: MintedToken) => setMinted(next), [])
  const requestRevoke = useCallback((target: RevokeTarget) => setRevokeTarget(target), [])
  const requestEditRoots = useCallback((target: RootsTarget) => setRootsTarget(target), [])
  const requestRestart = useCallback(() => setRestartOpen(true), [])
  const requestStart = useCallback(() => void runRestart(), [runRestart])

  const revoke = async (): Promise<void> => {
    if (!revokeTarget) return
    const { name, revoke: run } = revokeTarget
    try {
      await run()
      toast.success(`Revoked ${name}`)
    } catch (err) {
      toast.error(`Revoke failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    setRevokeTarget(null)
  }

  const copyToken = async (token: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(token)
      toast.success('Token copied')
    } catch {
      toast.error('Could not copy to clipboard')
    }
  }

  // A loopback dial target means the token only works for a runner on the hub's OWN
  // machine. Legitimate (that is the co-located case), so this informs rather than
  // blocks — but silence here is how an operator ends up with a runner that never
  // connects and no clue why.
  const mintedIsLoopback = minted?.hubUrl !== undefined && isLoopbackRunnerUrl(minted.hubUrl)

  return (
    <RunnerActionsContext.Provider
      value={{
        showMintedToken,
        requestRevoke,
        requestEditRoots,
        requestRestart,
        requestStart,
        restarting,
        runnerRevision
      }}
    >
      {children}

      {/* The runner's filesystem path-jail. Lives here for the same reason the
          other two do — one instance, driven by whichever hub's block asked —
          and the target carries hub-bound read/write thunks so an edit cannot
          land on the wrong hub's runner. */}
      {/* Keyed by runner so opening a DIFFERENT one gets a fresh dialog rather
          than one still holding the previous runner's unsaved edits. */}
      <RunnerRootsDialog
        key={rootsTarget?.id ?? 'none'}
        target={rootsTarget}
        onClose={() => setRootsTarget(null)}
      />

      {/* Enrollment token — one-time secret; modal forces a copy before dismiss. */}
      <Dialog open={!!minted} onOpenChange={(open) => !open && setMinted(null)}>
        <DialogContent data-testid="runner-minted-token">
          <DialogHeader>
            <DialogTitle>Enrollment token</DialogTitle>
            <DialogDescription>
              Shown once. Paste it into the runner&apos;s config now — it can&apos;t be retrieved
              later.
            </DialogDescription>
          </DialogHeader>
          {/* Name the hub: with several connected, a token pasted onto the wrong
              machine is indistinguishable from a broken one. */}
          <p className="text-muted-foreground text-xs" data-testid="runner-minted-hub">
            This runner will connect to <span className="text-foreground">{minted?.hubLabel}</span>
            {minted?.hubUrl ? <span className="font-mono"> ({minted.hubUrl})</span> : null}
          </p>
          <code className="text-muted-foreground border-border block max-w-full overflow-x-auto rounded-md border p-3 font-mono text-xs break-all">
            {minted?.token}
          </code>
          {mintedIsLoopback && (
            <p
              className="text-muted-foreground flex gap-2 text-xs"
              data-testid="runner-token-loopback-warning"
            >
              <AlertTriangle className="text-destructive mt-0.5 size-3.5 shrink-0" />
              <span>
                This hub&apos;s address is loopback, so only a runner on the SAME machine can use
                this token — anywhere else it would dial its own loopback and never connect. For a
                hub other machines reach, recreate it with{' '}
                <span className="font-mono">slay hub create --public-address</span>.
              </span>
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                if (minted) void copyToken(minted.token)
              }}
            >
              <Copy className="mr-1 size-3.5" />
              Copy
            </Button>
            <Button onClick={() => setMinted(null)} data-testid="runner-token-dismiss">
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Restarting the local runner is not like restarting the hub: every agent
          pty on this machine is a DIRECT CHILD of that process, so confirm. */}
      <AlertDialog open={restartOpen} onOpenChange={setRestartOpen}>
        <AlertDialogContent data-testid="runner-local-restart-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Restart local runner</AlertDialogTitle>
            <AlertDialogDescription>
              Every agent and terminal running on this machine stops immediately — they are all
              child processes of the runner. The runner reconnects on its own, but running agents do
              not resume and unsaved terminal state is lost. Runners on other machines are
              unaffected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void runRestart()
              }}
              data-testid="runner-local-restart-confirm"
            >
              Restart
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!revokeTarget} onOpenChange={(open) => !open && setRevokeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke Runner</AlertDialogTitle>
            <AlertDialogDescription>
              Revoke <strong>{revokeTarget?.name}</strong>? It will no longer be able to connect to
              its hub, and any task pinned to it falls back to the project default. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void revoke()
              }}
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </RunnerActionsContext.Provider>
  )
}
