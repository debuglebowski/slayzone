import type { TasksTrpcClient } from './trpc'

/**
 * Why the client reloaded a whole board (`task.loadBoardData`, every task — MBs), not
 * a patch. Recorded as the `board.full_load` diagnostic so the hub's traffic can be
 * traced to its cause: a load nothing explains here is a path that still needs one.
 * - `boot`: the first load of a hub's board.
 * - `unscoped-event`: a `tasks-changed` that named no rows.
 * - `reconnect`: the hub's socket dropped and reopened (its pushes were missed).
 * - `refresh`: an explicit refresh-everything (`__slayzone_refreshData`).
 * - `sharing`: the user gained or lost a shared project or task.
 * - `patch-fallback:<why>` / `parts-fallback:<why>`: a patch that could not vouch for
 *   its result.
 */
export type BoardLoadReason =
  | 'boot'
  | 'unscoped-event'
  | 'reconnect'
  | 'refresh'
  | 'sharing'
  | `patch-fallback:${string}`
  | `parts-fallback:${string}`

/** Best-effort: a hub that cannot take it (or an older one) just misses the record. */
export function reportBoardLoad(
  client: TasksTrpcClient,
  hub: 'default' | 'extra',
  reason: BoardLoadReason
): void {
  try {
    void client.diagnostics.recordClientEvent
      .mutate({
        event: 'board.full_load',
        level: 'info',
        message: reason,
        payload: { hub, reason }
      })
      .catch(() => undefined)
  } catch {
    /* no diagnostics router on this client */
  }
}
