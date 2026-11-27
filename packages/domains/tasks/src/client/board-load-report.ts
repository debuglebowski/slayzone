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

/**
 * The payload of a `board.full_load`: the reason as one boolean key (`patch-fallback:
 * unplaceable` → `patchFallback_unplaceable: true`) and `extraHub`. Booleans because a
 * renderer diagnostic keeps no free-text string (chat privacy, diagnostics
 * `chat-privacy.ts`), and these carry nothing but the cause.
 */
export function boardLoadPayload(
  hub: 'default' | 'extra',
  reason: BoardLoadReason
): Record<string, boolean> {
  const [kind, why] = reason.split(':')
  const camel = (kind ?? '').replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
  const key = why ? `${camel}_${why.replace(/[^A-Za-z0-9]+/g, '_')}` : camel
  return { extraHub: hub === 'extra', [key]: true }
}

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
        payload: boardLoadPayload(hub, reason)
      })
      .catch(() => undefined)
  } catch {
    /* no diagnostics router on this client */
  }
}
