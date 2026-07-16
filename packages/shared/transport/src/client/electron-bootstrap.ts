import type { ElectronAPI, HubEntry } from '@slayzone/types'

declare global {
  interface Window {
    api: ElectronAPI
  }
}

function api(): ElectronAPI {
  return window.api
}

export const electronBootstrap = {
  getServerUrl: () => api().app.getServerUrl(),
  // Pre-boot config not backed by the settings DB (fleet/multi-hub — decided at boot).
  getBootConfig: () => api().app.getBootConfig(),
  // Resolved multi-hub registry (local always first + present when multiHub on).
  getHubRegistry: () => api().app.getHubRegistry(),
  // Per-hub bearer tokens (safeStorage-decrypted in main) for authed remote hubs.
  getHubTokens: () => api().app.getHubTokens(),
  setHubToken: (payload: { hubId: string; token: string }) => api().app.setHubToken(payload),
  getWindowId: () => api().app.getWindowId(),
  setBootSettings: (payload: {
    server_mode?: 'local' | 'remote'
    remote_server_url?: string
    fleet_mode?: boolean
    multi_hub?: boolean
    hubs?: HubEntry[]
    default_hub_id?: string
  }) => api().app.setBootSettings(payload),
  probeServerHealth: (url: string) => api().app.probeServerHealth(url),
  relaunch: () => api().app.relaunch(),
  restartSidecar: () => api().app.restartSidecar(),
  // Boot instrumentation is pure timing telemetry — optional outside Electron
  // (e.g. the Chromium-fork window.api shim need not implement it). Optional-
  // chain so a missing host method is a no-op, not a TypeError that aborts the
  // first data load. No-op under Electron too (the method exists there).
  dataReady: () => api().app.dataReady?.() ?? Promise.resolve(),
  bootMark: (label: string) => api().app.bootMark?.(label),
  isPlaywright: () => api().app.isPlaywright,
  getDropPaths: () => api().files.getDropPaths(),
  getPastePaths: () => api().files.getPastePaths()
}
