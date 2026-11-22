/**
 * Which tRPC procedures are served by the DESKTOP (the Electron host), not by a hub.
 *
 * These routers run nothing hub-side: each delegates to the host behind the
 * capability bridge, which exists only between a desktop and its co-located local
 * hub. A remote hub serves them as fail-loud stubs. So a renderer must send them
 * to the local hub even from inside a remote task's `HubScope` — the client's
 * per-hub link stack does that with {@link isHostPath} (`hostRouteLink`).
 *
 * Classified per `app.<router>` (plus `menu`, minus its hub-raised streams in
 * {@link HUB_MENU_PROCEDURES}). Every `app.*` router must
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
  'clipboard',
  'dialog',
  'files',
  'floatingAgent',
  'meta',
  'shell',
  'shortcuts',
  'taskWindows',
  'window'
]

/**
 * `app.<router>`s served from the hub's own data — stay on the scoped hub.
 * `browserRelay` is the hub's own relay: a task's browser panel serves its tabs to
 * the hub that owns the task, so it must reach that hub, never the local one.
 */
export const HUB_APP_ROUTERS: readonly string[] = [
  'backup',
  'browserRelay',
  'exportImport',
  'feedback',
  'leaderboard',
  'usage'
]

/**
 * `menu.*` streams a HUB raises (its REST/MCP routes: `slay tasks open`, `slay
 * browser`, artifact open, …) about its OWN tasks — not native menu events. Every
 * hub serves them from its own bus, so each must be heard on the hub that owns the
 * task: forwarded to the local hub, a remote hub's emit reaches no one.
 */
export const HUB_MENU_PROCEDURES: readonly string[] = [
  'menu.onOpenTask',
  'menu.onCloseTask',
  'menu.onOpenArtifact',
  'menu.onBrowserEnsurePanelOpen',
  'menu.onBrowserCreateTab',
  'menu.onBrowserAgentTouched'
]

/** True when `path` (dotted, e.g. `app.shell.openExternal`) runs on the desktop host. */
export function isHostPath(path: string): boolean {
  if (HUB_MENU_PROCEDURES.includes(path)) return false
  const [root, sub] = path.split('.', 2)
  if (HOST_ROOT_ROUTERS.includes(root)) return true
  return root === 'app' && sub !== undefined && HOST_APP_ROUTERS.includes(sub)
}
