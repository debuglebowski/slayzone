import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { ElectronAPI } from '@slayzone/types'
import type { TerminalState, PromptInfo } from '@slayzone/terminal/shared'

// Prevent Electron's default file drop behavior (navigates to the file).
// Must be in the preload's main world — isolated world's preventDefault alone
// may not be seen by Chromium's drop allowance check.
let lastDropPaths: string[] = []
let lastPastePaths: string[] = []
window.addEventListener('dragover', (e) => e.preventDefault(), true)
window.addEventListener('drop', (e) => {
  e.preventDefault()
  if (!e.dataTransfer?.files.length) return
  lastDropPaths = Array.from(e.dataTransfer.files).map((f) => webUtils.getPathForFile(f))
}, true)
// Electron 32+ removed File.path; webUtils.getPathForFile only runs in main
// world. Capture here so renderers can resolve Finder-pasted file paths.
// Reset on every paste — text pastes must clear prior file-paste state so
// later consumers don't read stale paths.
window.addEventListener('paste', (e) => {
  const files = e.clipboardData?.files
  lastPastePaths = files?.length
    ? Array.from(files).map((f) => webUtils.getPathForFile(f))
    : []
}, true)

// Custom APIs for renderer
const api: ElectronAPI = {
  shortcuts: {
    changed: () => ipcRenderer.send('shortcuts:changed'),
  },
  app: {
    getTrpcPort: () => ipcRenderer.invoke('app:get-trpc-port') as Promise<number>,
    getServerUrl: () => ipcRenderer.invoke('app:get-server-url') as Promise<{ mode: 'local' | 'remote'; url: string }>,
    relaunch: () => ipcRenderer.invoke('app:relaunch') as Promise<void>,
    setBootSettings: (payload: { server_mode?: 'local' | 'remote'; remote_server_url?: string }) =>
      ipcRenderer.invoke('app:set-boot-settings', payload) as Promise<{ ok: true }>,
    isTestsPanelEnabledSync: ipcRenderer.sendSync('app:is-tests-panel-enabled-sync') as boolean,
    isJiraIntegrationEnabledSync: ipcRenderer.sendSync('app:is-jira-integration-enabled-sync') as boolean,
    isLoopModeEnabledSync: ipcRenderer.sendSync('app:is-loop-mode-enabled-sync') as boolean,
    isPlaywright: process.env.PLAYWRIGHT === '1',
    // Stable per-window id obtained via sync IPC at preload load. Each Electron
    // BrowserWindow has its own preload context, so this id is unique to the
    // window and survives page reloads (same webContents.id).
    windowId: ipcRenderer.sendSync('preload:get-window-id') as number,
    dataReady: () => ipcRenderer.send('app:data-ready'),
    // No-op in prod — only emits IPC when main is collecting boot timing.
    // Avoids per-cold-start IPC waste for an instrumentation hook.
    bootMark: process.env.SLAYZONE_DEBUG_BOOT === '1'
      ? (label: string) => ipcRenderer.send('boot:mark', label)
      : () => {},
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
  },
  pty: {
    create: (opts) => ipcRenderer.invoke('pty:create', opts),
    testExecutionContext: (context) => ipcRenderer.invoke('pty:testExecutionContext', context),
    ccsListProfiles: () => ipcRenderer.invoke('pty:ccsListProfiles'),
    write: (sessionId, data) => ipcRenderer.invoke('pty:write', sessionId, data),
    submit: (sessionId, text) => ipcRenderer.invoke('pty:submit', sessionId, text),
    setTheme: (theme) => ipcRenderer.invoke('pty:set-theme', theme),
    setShellOverride: (value) => ipcRenderer.invoke('pty:setShellOverride', value),
    resize: (sessionId, cols, rows) => ipcRenderer.invoke('pty:resize', sessionId, cols, rows),
    kill: (sessionId) => ipcRenderer.invoke('pty:kill', sessionId),
    exists: (sessionId) => ipcRenderer.invoke('pty:exists', sessionId),
    getBuffer: (sessionId) => ipcRenderer.invoke('pty:getBuffer', sessionId),
    clearBuffer: (sessionId) => ipcRenderer.invoke('pty:clearBuffer', sessionId),
    getBufferSince: (sessionId, afterSeq) => ipcRenderer.invoke('pty:getBufferSince', sessionId, afterSeq),
    getHistorySnapshot: (sessionId: string, lineCount: number) =>
      ipcRenderer.invoke('pty:getHistorySnapshot', sessionId, lineCount),
    getHistoryBefore: (sessionId: string, currentEarliestOffset: number, lineCount: number) =>
      ipcRenderer.invoke('pty:getHistoryBefore', sessionId, currentEarliestOffset, lineCount),
    setArchiveCapMb: (mb: number) => ipcRenderer.invoke('pty:setArchiveCapMb', mb),
    list: () => ipcRenderer.invoke('pty:list'),
    onData: (callback: (sessionId: string, data: string, seq: number) => void) => {
      const handler = (_event: unknown, sessionId: string, data: string, seq: number) => callback(sessionId, data, seq)
      ipcRenderer.on('pty:data', handler)
      return () => ipcRenderer.removeListener('pty:data', handler)
    },
    onExit: (callback: (sessionId: string, exitCode: number) => void) => {
      const handler = (_event: unknown, sessionId: string, exitCode: number) =>
        callback(sessionId, exitCode)
      ipcRenderer.on('pty:exit', handler)
      return () => ipcRenderer.removeListener('pty:exit', handler)
    },
    onRespawnSuggested: (callback: (taskId: string) => void) => {
      const handler = (_event: unknown, taskId: string) => callback(taskId)
      ipcRenderer.on('pty:respawn-suggested', handler)
      return () => ipcRenderer.removeListener('pty:respawn-suggested', handler)
    },
    onForceRespawn: (callback: (taskId: string, reqId: number) => void) => {
      const handler = (_event: unknown, taskId: string, reqId: number) => callback(taskId, reqId)
      ipcRenderer.on('pty:respawn-forced', handler)
      return () => ipcRenderer.removeListener('pty:respawn-forced', handler)
    },
    ackForceRespawn: (reqId: number, ok: boolean) => {
      ipcRenderer.send('pty:respawn-forced:ack', reqId, ok)
    },
    onSessionNotFound: (callback: (sessionId: string) => void) => {
      const handler = (_event: unknown, sessionId: string) => callback(sessionId)
      ipcRenderer.on('pty:session-not-found', handler)
      return () => ipcRenderer.removeListener('pty:session-not-found', handler)
    },
    onStateChange: (
      callback: (sessionId: string, newState: TerminalState, oldState: TerminalState) => void
    ) => {
      const handler = (
        _event: unknown,
        sessionId: string,
        newState: TerminalState,
        oldState: TerminalState
      ) => callback(sessionId, newState, oldState)
      ipcRenderer.on('pty:state-change', handler)
      return () => ipcRenderer.removeListener('pty:state-change', handler)
    },
    onPrompt: (callback: (sessionId: string, prompt: PromptInfo) => void) => {
      const handler = (_event: unknown, sessionId: string, prompt: PromptInfo) =>
        callback(sessionId, prompt)
      ipcRenderer.on('pty:prompt', handler)
      return () => ipcRenderer.removeListener('pty:prompt', handler)
    },
    onSessionDetected: (callback: (sessionId: string, conversationId: string) => void) => {
      const handler = (_event: unknown, sessionId: string, conversationId: string) =>
        callback(sessionId, conversationId)
      ipcRenderer.on('pty:session-detected', handler)
      return () => ipcRenderer.removeListener('pty:session-detected', handler)
    },
    onDevServerDetected: (callback: (sessionId: string, url: string) => void) => {
      const handler = (_event: unknown, sessionId: string, url: string) =>
        callback(sessionId, url)
      ipcRenderer.on('pty:dev-server-detected', handler)
      return () => ipcRenderer.removeListener('pty:dev-server-detected', handler)
    },
    onTitleChange: (callback: (sessionId: string, title: string) => void) => {
      const handler = (_event: unknown, sessionId: string, title: string) =>
        callback(sessionId, title)
      ipcRenderer.on('pty:title-change', handler)
      return () => ipcRenderer.removeListener('pty:title-change', handler)
    },
    onResizeNeeded: (callback: (sessionId: string) => void) => {
      const handler = (_event: unknown, sessionId: string) => callback(sessionId)
      ipcRenderer.on('pty:resize-needed', handler)
      return () => ipcRenderer.removeListener('pty:resize-needed', handler)
    },
    onStats: (cb) => {
      const handler = (_event: unknown, stats: Record<string, import('@slayzone/types').ProcessStats>) => cb(stats)
      ipcRenderer.on('pty:stats', handler)
      return () => ipcRenderer.removeListener('pty:stats', handler)
    },
    getState: (sessionId: string) => ipcRenderer.invoke('pty:getState', sessionId),
    validate: (mode: string) => ipcRenderer.invoke('pty:validate', mode)
  },
  session: {
    list: () => ipcRenderer.invoke('session:list'),
    getState: (sessionId: string) => ipcRenderer.invoke('session:getState', sessionId)
  },
  terminalModes: {
    list: () => ipcRenderer.invoke('terminalModes:list'),
    get: (id) => ipcRenderer.invoke('terminalModes:get', id),
    create: (input) => ipcRenderer.invoke('terminalModes:create', input),
    update: (id, updates) => ipcRenderer.invoke('terminalModes:update', id, updates),
    delete: (id) => ipcRenderer.invoke('terminalModes:delete', id),
    test: (command) => ipcRenderer.invoke('terminalModes:test', command),
    restoreDefaults: () => ipcRenderer.invoke('terminalModes:restoreDefaults'),
    resetToDefaultState: () => ipcRenderer.invoke('terminalModes:resetToDefaultState')
  },
  telemetry: {
    onIpcEvent: (callback: (event: string, props: Record<string, unknown>) => void) => {
      const handler = (_: unknown, event: string, props: Record<string, unknown>) => callback(event, props)
      ipcRenderer.on('telemetry:ipc-event', handler)
      return () => ipcRenderer.removeListener('telemetry:ipc-event', handler)
    }
  },
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
    // Test-only: generic IPC invoke for test channels not in the typed API
    if (process.env.PLAYWRIGHT === '1') {
      contextBridge.exposeInMainWorld('__testInvoke', (channel: string, ...args: unknown[]) =>
        ipcRenderer.invoke(channel, ...args)
      )
      // Test-only: simulate main→renderer IPC events (e.g. browser-view:shortcut)
      contextBridge.exposeInMainWorld('__testEmit', (channel: string, data: unknown) =>
        ipcRenderer.emit(channel, {}, data)
      )
    }
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.api = api
}
