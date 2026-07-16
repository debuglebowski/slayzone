import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { ElectronAPI, HubEntry } from '@slayzone/types'

// Intentional bootstrap-only preload surface. Do not add domain APIs here.
// Renderer/backend traffic uses tRPC over WebSocket after boot.

let lastDropPaths: string[] = []
let lastPastePaths: string[] = []
const isPlaywright = process.env.PLAYWRIGHT === '1'

window.addEventListener('dragover', (event) => event.preventDefault(), true)
window.addEventListener(
  'drop',
  (event) => {
    event.preventDefault()
    if (!event.dataTransfer?.files.length) return
    lastDropPaths = Array.from(event.dataTransfer.files).map((file) =>
      webUtils.getPathForFile(file)
    )
  },
  true
)
window.addEventListener(
  'paste',
  (event) => {
    const files = event.clipboardData?.files
    lastPastePaths = files?.length
      ? Array.from(files).map((file) => webUtils.getPathForFile(file))
      : []
  },
  true
)

const api: ElectronAPI = {
  app: {
    getServerUrl: () =>
      ipcRenderer.invoke('app:get-server-url') as Promise<{ mode: 'local' | 'remote'; url: string }>,
    getBootConfig: () =>
      ipcRenderer.invoke('app:get-boot-config') as Promise<{ fleetMode: boolean; multiHub: boolean }>,
    getHubRegistry: () =>
      ipcRenderer.invoke('app:get-hub-registry') as Promise<{
        hubs: HubEntry[]
        defaultHubId: string
      }>,
    getHubTokens: () =>
      ipcRenderer.invoke('app:get-hub-tokens') as Promise<Record<string, string>>,
    setHubToken: (payload) =>
      ipcRenderer.invoke('app:set-hub-token', payload) as Promise<{ ok: true }>,
    getWindowId: () => ipcRenderer.invoke('app:get-window-id') as Promise<number | null>,
    relaunch: () => ipcRenderer.invoke('app:relaunch') as Promise<void>,
    setBootSettings: (payload) =>
      ipcRenderer.invoke('app:set-boot-settings', payload) as Promise<{ ok: true }>,
    probeServerHealth: (url) =>
      ipcRenderer.invoke('app:probe-server-health', url) as Promise<{
        ok: boolean
        normalizedUrl?: string
        error?: string
      }>,
    restartSidecar: () =>
      ipcRenderer.invoke('app:restart-sidecar') as Promise<{ ok: boolean; error?: string }>,
    isPlaywright,
    dataReady: () => ipcRenderer.send('app:data-ready'),
    bootMark:
      process.env.SLAYZONE_DEBUG_BOOT === '1'
        ? (label: string) => ipcRenderer.send('boot:mark', label)
        : () => undefined
  },
  files: {
    getDropPaths: () => {
      const paths = lastDropPaths
      lastDropPaths = []
      return paths
    },
    getPastePaths: () => {
      const paths = lastPastePaths
      lastPastePaths = []
      return paths
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

if (isPlaywright) {
  contextBridge.exposeInMainWorld('__testInvoke', (channel: string, ...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args)
  )
  contextBridge.exposeInMainWorld('__testEmit', (channel: string, data: unknown) => {
    window.dispatchEvent(new CustomEvent(channel, { detail: data }))
  })
}
