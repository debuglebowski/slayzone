/**
 * Which tRPC procedures are served by the DESKTOP (the Electron host), not by a hub.
 *
 * These routers run nothing hub-side: each delegates to the host behind the
 * capability bridge, which exists only between a desktop and its co-located local
 * hub. A remote hub serves them as fail-loud stubs. So a renderer must send them
 * to the local hub even from inside a remote task's `HubScope` — the client's
 * per-hub link stack does that with {@link isHostPath} (`hostRouteLink`).
 *
 * Classified per `app.<router>` (plus all of `menu`). Every `app.*` router must
 * be listed in exactly one of the two sets; `api`'s `host-paths.test.ts` checks
 * that against the live router, so a new `app.*` router fails CI until someone
 * decides where it runs.
 *
 * Pure data, like `scopes.ts`: the client imports it, so no router imports here.
 */

/** Top-level routers that are host-only in full. */
export const HOST_ROOT_ROUTERS: readonly string[] = ['menu']

/** `app.<router>`s served by the desktop host (capability bridge). */
export const HOST_APP_ROUTERS: readonly string[] = [
  'auth',
  'browser',
  'clipboard',
  'dialog',
  'files',
  'floatingAgent',
  'meta',
  'screenshot',
  'shell',
  'shortcuts',
  'taskWindows',
  'webview',
  'window'
]

/** `app.<router>`s served from the hub's own data — stay on the scoped hub. */
export const HUB_APP_ROUTERS: readonly string[] = [
  'backup',
  'exportImport',
  'feedback',
  'leaderboard',
  'usage'
]

/** True when `path` (dotted, e.g. `app.shell.openExternal`) runs on the desktop host. */
export function isHostPath(path: string): boolean {
  const [root, sub] = path.split('.', 2)
  if (HOST_ROOT_ROUTERS.includes(root)) return true
  return root === 'app' && sub !== undefined && HOST_APP_ROUTERS.includes(sub)
}
