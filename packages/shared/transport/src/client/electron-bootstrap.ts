import type { ElectronAPI, HubEntry } from '@slayzone/types'

declare global {
  interface Window {
    api: ElectronAPI
  }
}

function api(): ElectronAPI {
  return window.api
}

/**
 * Every call below is optional-chained against a FALLBACK, even though every
 * method is required on the `ElectronAPI` TYPE. The type is a promise about
 * what a real host implements; it is not runtime-enforced across the
 * `window.api` boundary, and a host can genuinely fall short of it — the
 * fork's `window-api-shim` degrades much of its surface, and a future or
 * partial web-shell build could too. Before this widening only `dataReady`/
 * `bootMark` were guarded; every other call was bare, so a missing method
 * threw an uncaught `TypeError` that could abort the very first data load
 * (`Terminal.tsx`'s bare `getPastePaths()` call is exactly this — it throws
 * on the fork today). A missing method degrading to a documented fallback,
 * the same way an explicit "not supported" `hubLogin` response already does,
 * is strictly better than a crash for a bootstrap-only, best-effort surface.
 *
 * Every fallback below is chosen to be exactly what a "not supported" answer
 * already looks like elsewhere in this same file (`{ok:false, error:...}`
 * for the methods with an error variant, an inert-but-valid empty value for
 * the read methods) — never a value a caller could mistake for success.
 */
const NOT_IMPLEMENTED = 'Not implemented by this host'

export const electronBootstrap = {
  getServerUrl: () =>
    api().app.getServerUrl?.() ?? Promise.resolve({ mode: 'local' as const, url: '' }),
  // Pre-boot config not backed by the settings DB (computer/multi-hub — decided at boot).
  getBootConfig: () => api().app.getBootConfig?.() ?? Promise.resolve({ multiHub: false }),
  // Resolved multi-hub registry (local always first + present when multiHub on).
  getHubRegistry: () =>
    api().app.getHubRegistry?.() ?? Promise.resolve({ hubs: [] as HubEntry[], defaultHubId: '' }),
  // Per-hub bearer tokens (safeStorage-decrypted in main) for authed remote hubs.
  getHubTokens: () => api().app.getHubTokens?.() ?? Promise.resolve({}),
  setHubToken: (payload: { hubId: string; token: string }) =>
    api().app.setHubToken?.(payload) ?? Promise.resolve({ ok: true as const }),
  hubLogin: (payload: { hubId: string; url: string; email: string; password: string }) =>
    api().app.hubLogin?.(payload) ??
    Promise.resolve({ ok: false as const, error: NOT_IMPLEMENTED }),
  getWindowId: () => api().app.getWindowId?.() ?? Promise.resolve(null),
  setBootSettings: (payload: {
    server_mode?: 'local' | 'remote'
    remote_server_url?: string
    multi_hub?: boolean
    hubs?: HubEntry[]
    default_hub_id?: string
  }) => api().app.setBootSettings?.(payload) ?? Promise.resolve({ ok: true as const }),
  probeServerHealth: (url: string) =>
    api().app.probeServerHealth?.(url) ??
    Promise.resolve({ ok: false as const, error: NOT_IMPLEMENTED }),
  relaunch: () => api().app.relaunch?.() ?? Promise.resolve(),
  restartSidecar: () =>
    api().app.restartSidecar?.() ?? Promise.resolve({ ok: false as const, error: NOT_IMPLEMENTED }),
  restartLocalComputer: () =>
    api().app.restartLocalComputer?.() ??
    Promise.resolve({ ok: false as const, error: NOT_IMPLEMENTED }),
  // Boot instrumentation is pure timing telemetry — optional outside Electron
  // (e.g. the Chromium-fork window.api shim need not implement it). Optional-
  // chain so a missing host method is a no-op, not a TypeError that aborts the
  // first data load. No-op under Electron too (the method exists there).
  dataReady: () => api().app.dataReady?.() ?? Promise.resolve(),
  bootMark: (label: string) => api().app.bootMark?.(label),
  isPlaywright: () => api().app.isPlaywright ?? false,
  getDropPaths: () => api().files.getDropPaths?.() ?? [],
  getPastePaths: () => api().files.getPastePaths?.() ?? []
}
