import { useState, useCallback, useEffect, useRef } from 'react'
import {
  useTRPCClient,
  useFederationOrNull,
  getHubClient,
  electronBootstrap,
  HubScope
} from '@slayzone/transport/client'
import { isLoopbackRunnerUrl } from '@slayzone/platform/hub-addr'
import { AlertTriangle, Copy, Loader2, Plus, X } from 'lucide-react'
import {
  Button,
  Input,
  Label,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast
} from '@slayzone/ui'
import { SettingsTabIntro } from './SettingsTabIntro'
import { RunnersHubRows } from './RunnersHubRows'

/**
 * Runner settings — enroll + manage the machines that run this client's work.
 *
 * A hub ALWAYS accepts runners (the gateway + auth + listener come up at boot
 * unconditionally), so there is no mode to enable: enrollment and the runners
 * table are always live. Enrolling is a row inside the table ("＋ Add new runner")
 * that expands into the label form inline; minting yields a one-time token shown
 * in a modal (forces a copy before dismiss — it can't be retrieved later). To
 * actually run a task's work on a runner, bind the project/task to it (task
 * metadata) — until then everything executes in-process.
 *
 * MULTI-HUB. A runner belongs to exactly ONE hub, and which hub is decided when
 * the token is MINTED (the token embeds that hub's dial URL + cert fingerprint).
 * So a federated client needs to choose a hub at mint time, and needs to see every
 * hub's runners — otherwise a remote hub's runners are invisible and
 * un-enrollable. Both are handled here:
 *
 *  - ONE merged table with a HUB column (mirroring the flat merged task rail), not
 *    a section per hub. Rows come from a `<RunnersHubRows>` child mounted once per
 *    hub inside that hub's `<HubScope>`, which is what makes per-row revoke
 *    hub-correct by construction — see that module's note.
 *  - the add row gains a hub picker, shown ONLY when >1 hub is connected. Mint is a
 *    VANILLA client call (`getHubClient`), because the chosen hub is dynamic and
 *    the shell is not inside its scope — the same idiom as CreateProjectDialog.
 *
 * Single hub (and the Chromium fork, which renders with no federation at all) is
 * unchanged: no Hub column, no picker, mint through the ambient client.
 */

/** The shell's own view of a revoke target — `revoke` is the child's hub-bound thunk. */
type RevokeTarget = { id: string; name: string; revoke: () => Promise<void> }

/**
 * How long to wait before the second post-restart refetch. The spawn returns as
 * soon as the process exists; enrolling + reporting connected happens after, and
 * `runners.list` does not poll — so without this the table would sit on
 * "Disconnected" until something else invalidated it.
 */
const RECONNECT_SETTLE_MS = 2000

/** A minted token plus where it points, so the dialog can warn about loopback. */
type MintedToken = {
  token: string
  hubLabel: string
  hubUrl: string | undefined
}

export function RunnersSettingsTab() {
  const trpcClient = useTRPCClient()
  // OrNull: the Chromium fork renders this surface outside a FederationProvider.
  const fed = useFederationOrNull()
  // A listed hub may have no url (an offline remote the registry still knows), and
  // an unresolvable hub cannot answer a query — filter before rendering scopes.
  const hubs = fed ? fed.hubs.filter((h) => !!h.url) : []
  const multiHub = hubs.length > 1
  const defaultHubId = fed?.defaultHubId ?? 'local'

  const [addingRunner, setAddingRunner] = useState(false)
  const [label, setLabel] = useState('')
  const [targetHubId, setTargetHubId] = useState(defaultHubId)
  const [minting, setMinting] = useState(false)
  const [minted, setMinted] = useState<MintedToken | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<RevokeTarget | null>(null)
  // Restart of the LOCAL runner (the app's own supervised child). Confirm-gated:
  // it stops every agent pty on this machine.
  const [restartOpen, setRestartOpen] = useState(false)
  const [restarting, setRestarting] = useState(false)
  // Per-hub row counts, so the header total is the UNION rather than one hub's.
  const [counts, setCounts] = useState<Record<string, number>>({})
  // Bumped after a mint so every hub's child refetches its own list.
  const [revision, setRevision] = useState(0)

  const onCount = useCallback((hubId: string, count: number) => {
    setCounts((prev) => (prev[hubId] === count ? prev : { ...prev, [hubId]: count }))
  }, [])

  const onRevokeRequest = useCallback((target: RevokeTarget) => {
    setRevokeTarget(target)
  }, [])

  // Plain functions, not useCallback: unlike `onCount` these are only click
  // handlers — nothing downstream puts them in a dependency array.
  const onRestartRequest = (): void => setRestartOpen(true)

  /**
   * Restart (or first-start) the app's own supervised runner.
   *
   * `electronBootstrap` rather than tRPC on purpose: the runner is a child of the
   * MAIN process, not of the hub. The hub can see the runner's registry row but
   * has no handle on the process, so only the desktop bridge can cycle it — and
   * on the Chromium fork, which does not spawn it, the shim answers "not
   * supported" and this surfaces as an ordinary error toast.
   *
   * The runner re-dials asynchronously after the spawn, so one immediate refetch
   * would always paint "Disconnected". `runners.list` does not poll, hence the
   * second, delayed bump.
   */
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current)
    },
    []
  )

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
      setRevision((r) => r + 1)
      if (settleTimer.current) clearTimeout(settleTimer.current)
      settleTimer.current = setTimeout(() => setRevision((r) => r + 1), RECONNECT_SETTLE_MS)
    }
  }, [])

  // Starting an absent runner destroys nothing, so it skips the confirm.
  const onStartRequest = (): void => void runRestart()

  const total = multiHub
    ? hubs.reduce((sum, h) => sum + (counts[h.id] ?? 0), 0)
    : (counts[defaultHubId] ?? 0)

  const hubLabelFor = (hubId: string): string =>
    hubs.find((h) => h.id === hubId)?.label ?? 'this hub'

  const addRunner = async (): Promise<void> => {
    setMinting(true)
    setMinted(null)
    try {
      // Route the mint to the chosen hub's client — the token belongs to whichever
      // hub minted it. Default/local resolves to the ambient client, so a
      // single-hub client takes the exact same path as before.
      const client =
        targetHubId && targetHubId !== defaultHubId
          ? (getHubClient(targetHubId)?.client ?? trpcClient)
          : trpcClient
      const res = await client.runners.mintJoinToken.mutate({
        label: label.trim() || 'runner'
      })
      setMinted({
        token: res.token,
        hubLabel: hubLabelFor(targetHubId),
        hubUrl: res.hubUrl
      })
      setLabel('')
      setAddingRunner(false)
      setRevision((r) => r + 1)
      toast.success('Enrollment token created')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`Could not create token: ${msg}`)
    } finally {
      setMinting(false)
    }
  }

  const revoke = async (): Promise<void> => {
    if (!revokeTarget) return
    const { name, revoke: run } = revokeTarget
    try {
      await run()
      toast.success(`Revoked ${name}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`Revoke failed: ${msg}`)
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

  const rowsFor = (hubId: string, hubLabel: string, isLocalHub: boolean) => (
    <RunnersHubRows
      hubId={hubId}
      hubLabel={hubLabel}
      showHubColumn={multiHub}
      onCount={onCount}
      onRevokeRequest={onRevokeRequest}
      isLocalHub={isLocalHub}
      onRestartRequest={onRestartRequest}
      onStartRequest={onStartRequest}
      restarting={restarting}
      revision={revision}
    />
  )

  return (
    <div className="space-y-6">
      <SettingsTabIntro
        title="Runners"
        description="Run terminals and agents on other machines. A hub is what runners dial into over an authenticated connection; enroll a runner below, then bind a project or task to it to execute its work there instead of locally."
      />

      <div className="space-y-3">
        <div className="flex items-baseline justify-between">
          <Label className="text-base font-semibold">Runners</Label>
          <span className="text-muted-foreground text-xs">
            {total === 0
              ? 'No runners enrolled yet.'
              : `${total} runner${total === 1 ? '' : 's'} enrolled`}
          </span>
        </div>
        <table className="w-full text-sm" data-testid="runners-table">
          <thead>
            <tr className="text-muted-foreground border-border border-b text-left text-xs">
              <th className="py-2 pr-3 font-medium">Name</th>
              {/* Hub sits next to Name: "which runner, on which hub" reads as one
                  fact. Only rendered when federated, so the single-hub table is
                  byte-identical to before. */}
              {multiHub && <th className="py-2 pr-3 font-medium">Hub</th>}
              <th className="py-2 pr-3 font-medium">Platform</th>
              <th className="py-2 pr-3 font-medium">Capabilities</th>
              <th className="py-2 pr-3 font-medium">Status</th>
              <th className="py-2 pr-3 font-medium">Last seen</th>
              <th className="py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {/* One child per hub, each in its own scope so its hooks resolve to that
                hub. Without federation (fork) there is no scope to enter — the
                ambient client is the only hub there is. */}
            {fed
              ? hubs.map((h) => (
                  <HubScope key={h.id} hubId={h.id}>
                    {rowsFor(h.id, h.label, h.kind === 'local')}
                  </HubScope>
                ))
              : // No federation = the Chromium fork, whose single hub IS the local
                // one. The restart still surfaces there; the shim answers with an
                // error toast rather than a dead button.
                rowsFor(defaultHubId, '', true)}
            {/* Add-runner row — collapsed to a button, expands into the label form. */}
            <tr className="border-border/60 border-b last:border-0" data-testid="runner-add-row">
              {addingRunner ? (
                <td colSpan={multiHub ? 7 : 6} className="py-2">
                  <div className="flex items-center gap-2">
                    <Input
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                      placeholder="Runner label (e.g. office-mac)"
                      disabled={minting}
                      className="max-w-xs"
                      data-testid="runner-enroll-label"
                    />
                    {multiHub && (
                      <Select value={targetHubId} onValueChange={setTargetHubId}>
                        <SelectTrigger className="max-w-[12rem]" data-testid="runner-add-hub">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {hubs.map((h) => (
                            <SelectItem key={h.id} value={h.id}>
                              {h.label}
                              {h.id === defaultHubId ? ' (default)' : ''}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    <Button
                      variant="outline"
                      disabled={minting}
                      onClick={() => {
                        void addRunner()
                      }}
                      data-testid="runner-add"
                    >
                      {minting ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                      Add a runner
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={minting}
                      onClick={() => {
                        setAddingRunner(false)
                        setLabel('')
                      }}
                      data-testid="runner-add-cancel"
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                  <p className="text-muted-foreground mt-2 text-xs">
                    {multiHub
                      ? 'Mint a one-time enrollment token on the chosen hub and paste it into the runner machine’s config. The runner connects to that hub — the token embeds its address and TLS fingerprint — and expires after 15 minutes.'
                      : 'Mint a one-time enrollment token and paste it into the runner machine’s config. The token embeds this hub’s address and TLS fingerprint, and expires after 15 minutes.'}
                  </p>
                </td>
              ) : (
                <td colSpan={multiHub ? 7 : 6} className="py-2">
                  <button
                    type="button"
                    onClick={() => setAddingRunner(true)}
                    className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-sm"
                    data-testid="runner-add-open"
                  >
                    <Plus className="size-4" />
                    Add new runner
                  </button>
                </td>
              )}
            </tr>
          </tbody>
        </table>
      </div>

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
              child processes of the runner. The runner reconnects on its own, but running agents
              do not resume and unsaved terminal state is lost. Runners on other machines are
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
    </div>
  )
}
