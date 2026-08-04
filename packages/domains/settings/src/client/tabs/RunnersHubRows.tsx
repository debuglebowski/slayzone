import { useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
// Leaf subpath, deliberately not `@slayzone/platform/slayzone-config`: that one
// imports node:fs/node:path, which rollup externalizes out of the renderer bundle
// and then fails to resolve. Same constant, browser-safe module.
import { DEFAULT_LOCAL_RUNNER_NAME } from '@slayzone/platform/runner-identity'
import { Button, cn } from '@slayzone/ui'
import { RotateCw, Trash2 } from 'lucide-react'

/**
 * One hub's runner rows, inside that hub's `<HubScope>`.
 *
 * WHY A SEPARATE COMPONENT. The Runners table is a UNION across every connected
 * hub, but `useTRPC()` resolves to the nearest provider — so a single component
 * cannot query more than one hub with hooks. Rendering this child once per hub
 * inside `<HubScope hubId>` gives each copy its own tRPC client + QueryClient, so
 * it uses ORDINARY `useQuery`/`useMutation` with no vanilla-client plumbing, no
 * manual cancellation, and per-hub loading/error for free.
 *
 * The load-bearing consequence is REVOKE: the mutation is created inside the hub's
 * own scope, so a row's revoke is bound to the hub that owns that row by
 * CONSTRUCTION. The alternative (one flat query loop + an id→hub origin map) makes
 * the same correctness a lookup that can silently go stale.
 *
 * Renders ONLY `<tr>`s — it is mounted directly inside the shell's `<tbody>`, and
 * `HubScope` itself emits no DOM, so the table markup stays valid.
 *
 * THE LOCAL RUNNER is the one row this client can control as a PROCESS rather
 * than as a registry entry: it is the app's own supervised child. So on the
 * local hub only, its row carries a restart action, and its ABSENCE gets a row of
 * its own — a local hub with no local runner cannot execute anything at all, and
 * before this that state was reachable (boot-time join-token mint failure) with
 * no way out but relaunching the app.
 */

export interface RunnersHubRowsProps {
  /** The hub these rows belong to (also the ambient HubScope's id). */
  hubId: string
  /** Display label for the Hub column. */
  hubLabel: string
  /** Whether to render the Hub cell — false on a single-hub client, so its DOM is
   *  unchanged from before federation reached this tab. */
  showHubColumn: boolean
  /** Report this hub's row count up so the shell can show the union total. */
  onCount: (hubId: string, count: number) => void
  /**
   * Ask the shell to confirm a revoke. Carries a `revoke` thunk closed over THIS
   * hub's mutation, so the shell's single confirm dialog needs to know nothing
   * about hub routing.
   */
  onRevokeRequest: (target: { id: string; name: string; revoke: () => Promise<void> }) => void
  /**
   * This hub is the LOCAL one — i.e. its runners include the app's own supervised
   * child, which is the only runner this client can restart. False for every
   * remote hub: their machines' processes are not ours to cycle.
   */
  isLocalHub: boolean
  /** Ask the shell to confirm restarting the local runner (it owns the dialog). */
  onRestartRequest: () => void
  /** Start a local runner that never came up. No confirm — nothing is running. */
  onStartRequest: () => void
  /** True while a restart/start is in flight, so the affordance can show it. */
  restarting: boolean
  /** Bumped by the shell after a successful mint, so this hub refetches its list. */
  revision: number
}

function formatLastSeen(row: { connected: boolean; lastSeenAt: number | null }): string {
  if (row.connected) return 'Connected'
  if (row.lastSeenAt == null) return 'Never'
  return new Date(row.lastSeenAt).toLocaleString()
}

export function RunnersHubRows({
  hubId,
  hubLabel,
  showHubColumn,
  onCount,
  onRevokeRequest,
  isLocalHub,
  onRestartRequest,
  onStartRequest,
  restarting,
  revision
}: RunnersHubRowsProps) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()

  // A hub always accepts runners, so the list is always available (no mode to
  // enable). `list` merges live connection status when a runner is connected;
  // it's a plain DB read otherwise.
  const runnersQuery = useQuery(trpc.runners.list.queryOptions())
  const runners = runnersQuery.data ?? []
  const revokeMutation = useMutation(trpc.runners.revokeRunner.mutationOptions())

  // Refetch after a mint anywhere in the table. Invalidating HERE hits this hub's
  // own QueryClient — the shell has no handle on it (that isolation is the point
  // of a per-hub QueryClient), so the signal has to travel as a plain counter.
  useEffect(() => {
    if (revision === 0) return
    void queryClient.invalidateQueries(trpc.runners.list.queryFilter())
  }, [revision, queryClient, trpc])

  useEffect(() => {
    onCount(hubId, runners.length)
  }, [hubId, runners.length, onCount])

  // Only meaningful on the local hub. Gated on `isSuccess` so the first render
  // (no data yet) doesn't flash "not running" at a perfectly healthy runner.
  const localRunnerMissing =
    isLocalHub &&
    runnersQuery.isSuccess &&
    !runners.some((r) => r.name === DEFAULT_LOCAL_RUNNER_NAME)

  return (
    <>
      {runners.map((runner) => (
        <tr key={runner.id} className="border-border/60 border-b" data-testid="runner-row">
          <td className="py-2 pr-3 font-medium">{runner.name}</td>
          {showHubColumn && (
            <td className="text-muted-foreground py-2 pr-3 text-xs" data-testid="runner-hub-cell">
              {hubLabel}
            </td>
          )}
          <td className="text-muted-foreground py-2 pr-3 font-mono text-xs">{runner.platform}</td>
          <td className="text-muted-foreground py-2 pr-3 text-xs">
            {runner.capabilities.length > 0 ? runner.capabilities.join(', ') : '—'}
          </td>
          <td className="py-2 pr-3">
            <span
              className={
                runner.connected
                  ? 'text-green-500 text-xs font-medium'
                  : 'text-muted-foreground text-xs'
              }
            >
              {runner.connected ? '● Connected' : 'Disconnected'}
            </span>
          </td>
          <td className="text-muted-foreground py-2 pr-3 text-xs">{formatLastSeen(runner)}</td>
          <td className="py-2 text-right">
            {/* The app's OWN supervised child — the one runner it can cycle as a
                process. Restarting kills every agent pty on this machine, so the
                shell gates it behind a confirm. */}
            {isLocalHub && runner.name === DEFAULT_LOCAL_RUNNER_NAME && (
              <Button
                variant="ghost"
                size="sm"
                disabled={restarting}
                title="Restart local runner (stops running agents + terminals; reconnects automatically)"
                onClick={onRestartRequest}
                data-testid="runner-local-restart"
              >
                <RotateCw className={cn('size-3.5', restarting && 'animate-spin')} />
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                onRevokeRequest({
                  id: runner.id,
                  name: runner.name,
                  // Closed over this hub's mutation + QueryClient, so the shell
                  // cannot route a revoke to the wrong hub.
                  revoke: async () => {
                    await revokeMutation.mutateAsync({ runnerId: runner.id })
                    void queryClient.invalidateQueries(trpc.runners.list.queryFilter())
                  }
                })
              }
              data-testid="runner-revoke"
            >
              <Trash2 className="size-3.5 text-destructive" />
            </Button>
          </td>
        </tr>
      ))}
      {/* No local runner on the local hub = nothing on this machine can execute:
          agents, terminals and git work all run on runners. Reachable when the
          boot-time join-token mint fails (diagnostic `local_runner.unspawned`),
          which used to be recoverable only by relaunching the app. */}
      {localRunnerMissing && (
        <tr className="border-border/60 border-b" data-testid="runner-local-missing">
          <td className="text-muted-foreground py-2 pr-3 font-medium">Local runner</td>
          {showHubColumn && (
            <td className="text-muted-foreground py-2 pr-3 text-xs">{hubLabel}</td>
          )}
          <td className="text-muted-foreground py-2 pr-3 font-mono text-xs">—</td>
          <td className="text-muted-foreground py-2 pr-3 text-xs">—</td>
          <td className="py-2 pr-3">
            <span className="text-destructive text-xs font-medium">Not running</span>
          </td>
          <td className="text-muted-foreground py-2 pr-3 text-xs">—</td>
          <td className="py-2 text-right">
            <Button
              variant="outline"
              size="sm"
              disabled={restarting}
              title="Start the local runner — agents, terminals and git work all run on runners"
              onClick={onStartRequest}
              data-testid="runner-local-start"
            >
              {restarting ? <RotateCw className="mr-1 size-3.5 animate-spin" /> : null}
              Start
            </Button>
          </td>
        </tr>
      )}
    </>
  )
}
