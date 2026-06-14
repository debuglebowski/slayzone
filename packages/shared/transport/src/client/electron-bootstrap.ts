import type { ElectronAPI } from '@slayzone/types'

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
  getWindowId: () => api().app.getWindowId(),
  setBootSettings: (payload: { server_mode?: 'local' | 'remote'; remote_server_url?: string }) =>
    api().app.setBootSettings(payload),
  probeServerHealth: (url: string) => api().app.probeServerHealth(url),
  relaunch: () => api().app.relaunch(),
  dataReady: () => api().app.dataReady(),
  bootMark: (label: string) => api().app.bootMark(label),
  isPlaywright: () => api().app.isPlaywright,
  getDropPaths: () => api().files.getDropPaths(),
  getPastePaths: () => api().files.getPastePaths()
}
