import { useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import { Button } from '@slayzone/ui'
import { Trash2 } from 'lucide-react'

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
    </>
  )
}
