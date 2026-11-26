import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { ElectronAPI, HubEntry, LocalComputerHubs, LocalComputerStatus } from '@slayzone/types'
import type {
  ArtifactExportRequest,
  ArtifactExportResult,
  HostSaveResult,
  SaveTargetOpenResult,
  SaveTargetRequest
} from '@slayzone/platform/electron-bootstrap-contract'

// Intentional bootstrap + client-local host surface (ARCHITECTURE.md). Do not add domain
// APIs here.
// Renderer/backend traffic uses tRPC over WebSocket after boot.

let lastDropPaths: string[] = []
let lastPastePaths: string[] = []
const isPlaywright = process.env.PLAYWRIGHT === '1'
const browserHostListeners = new Set<(event: string, payload: unknown) => void>()
let browserHostSubscribed = false
const clientHostListeners = new Set<(event: string, payload: unknown) => void>()
let clientHostSubscribed = false

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
      ipcRenderer.invoke('app:get-server-url') as Promise<{
        mode: 'local' | 'remote'
        url: string
      }>,
    getBootConfig: () =>
      ipcRenderer.invoke('app:get-boot-config') as ReturnType<ElectronAPI['app']['getBootConfig']>,
    getHubRegistry: () =>
      ipcRenderer.invoke('app:get-hub-registry') as Promise<{
        hubs: HubEntry[]
        defaultHubId: string
      }>,
    getHubTokens: () => ipcRenderer.invoke('app:get-hub-tokens') as Promise<Record<string, string>>,
    checkHubSession: (payload: { hubId: string; url: string }) =>
      ipcRenderer.invoke('app:check-hub-session', payload) as Promise<
        | { state: 'valid'; email: string | null }
        | { state: 'expired' }
        | { state: 'unreachable' }
        | { state: 'none' }
      >,
    setHubToken: (payload) =>
      ipcRenderer.invoke('app:set-hub-token', payload) as Promise<{ ok: true }>,
    hubLogin: (payload) =>
      ipcRenderer.invoke('app:hub-login', payload) as Promise<
        { ok: true } | { ok: false; error: string }
      >,
    hubDeviceLoginStart: (payload) =>
      ipcRenderer.invoke('app:hub-device-login-start', payload) as ReturnType<
        ElectronAPI['app']['hubDeviceLoginStart']
      >,
    hubDeviceLoginWait: (payload) =>
      ipcRenderer.invoke('app:hub-device-login-wait', payload) as ReturnType<
        ElectronAPI['app']['hubDeviceLoginWait']
      >,
    hubDeviceLoginCancel: (payload) =>
      ipcRenderer.invoke('app:hub-device-login-cancel', payload) as Promise<{ ok: true }>,
    getWindowId: () => ipcRenderer.invoke('app:get-window-id') as Promise<number | null>,
    setAppBadge: (badge) => ipcRenderer.invoke('app:set-badge', badge) as Promise<void>,
    setQuitGuard: (guard) => ipcRenderer.invoke('app:set-quit-guard', guard) as Promise<void>,
    relaunch: () => ipcRenderer.invoke('app:relaunch') as Promise<void>,
    setBootSettings: (payload) =>
      ipcRenderer.invoke('app:set-boot-settings', payload) as Promise<{ ok: true }>,
    probeServerHealth: (url) =>
      ipcRenderer.invoke('app:probe-server-health', url) as Promise<{
        ok: boolean
        normalizedUrl?: string
        error?: string
        authRequired?: boolean
        signIn?: { sso: boolean; password: boolean }
      }>,
    floatingAgentBootFailed: () =>
      ipcRenderer.invoke('floating-global-agent-panel:boot-failed') as Promise<void>,
    prepareDirectLink: (address: string, hubId: string) =>
      ipcRenderer.invoke('app:direct-link-prepare', address, hubId) as Promise<
        { ok: true } | { ok: false; reason: 'invalid' | 'not-issued' | 'csp' | 'unreachable' }
      >,
    // Client-local host capability, not a domain API: the export renders on THIS device.
    exportArtifact: (request: ArtifactExportRequest) =>
      ipcRenderer.invoke('app:export-artifact', request) as Promise<ArtifactExportResult>,
    configureArtifactDevicePreview: (id, url, viewport) =>
      ipcRenderer.invoke(
        'app:configure-artifact-device-preview',
        id,
        url,
        viewport
      ) as Promise<boolean>,
    saveTargetOpen: (request: SaveTargetRequest) =>
      ipcRenderer.invoke('app:save-target-open', request) as Promise<SaveTargetOpenResult>,
    saveTargetWrite: (targetId: string, path: string, data: Uint8Array, size?: number) =>
      ipcRenderer.invoke('app:save-target-write', targetId, path, data, size) as Promise<void>,
    saveTargetMkdir: (targetId: string, path: string) =>
      ipcRenderer.invoke('app:save-target-mkdir', targetId, path) as Promise<void>,
    saveTargetClose: (targetId: string) =>
      ipcRenderer.invoke('app:save-target-close', targetId) as Promise<HostSaveResult>,
    saveTargetAbort: (targetId: string) =>
      ipcRenderer.invoke('app:save-target-abort', targetId) as Promise<void>,
    restartSidecar: () =>
      ipcRenderer.invoke('app:restart-sidecar') as Promise<{ ok: boolean; error?: string }>,
    restartLocalComputer: () =>
      ipcRenderer.invoke('app:restart-local-computer') as Promise<{ ok: boolean; error?: string }>,
    getLocalComputerStatus: () =>
      ipcRenderer.invoke('app:get-local-computer-status') as Promise<LocalComputerStatus | null>,
    getLocalComputerHubs: () =>
      ipcRenderer.invoke('app:get-local-computer-hubs') as Promise<LocalComputerHubs>,
    isPlaywright,
    dataReady: () => ipcRenderer.send('app:data-ready'),
    bootMark:
      process.env.SLAYZONE_DEBUG_BOOT === '1'
        ? (label: string) => ipcRenderer.send('boot:mark', label)
        : () => undefined
  },
  // Client-local host capability, not a domain API: the browser panel drives the web
  // views on THIS device (see browser-host-ipc.ts). Never routed through the hub.
  browserHost: {
    invoke: (method, args) => ipcRenderer.invoke('browser-host:invoke', method, args),
    on: (listener) => {
      browserHostListeners.add(listener)
      if (!browserHostSubscribed) {
        browserHostSubscribed = true
        ipcRenderer.on('browser-host:event', (_e, event: string, payload: unknown) => {
          for (const l of browserHostListeners) l(event, payload)
        })
        ipcRenderer.send('browser-host:subscribe')
      }
      return () => {
        browserHostListeners.delete(listener)
      }
    }
  },
  // Client-local host capability, not a domain API: what THIS device owns (theme
  // mode, labs, shortcut overrides, zoom, updates) and its native-menu events (see
  // client-host-ipc.ts). Never routed through the hub.
  clientHost: {
    invoke: (method, args) => ipcRenderer.invoke('client-host:invoke', method, args),
    on: (listener) => {
      clientHostListeners.add(listener)
      if (!clientHostSubscribed) {
        clientHostSubscribed = true
        ipcRenderer.on('client-host:event', (_e, event: string, payload: unknown) => {
          for (const l of clientHostListeners) l(event, payload)
        })
        ipcRenderer.send('client-host:subscribe')
      }
      return () => {
        clientHostListeners.delete(listener)
      }
    }
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
