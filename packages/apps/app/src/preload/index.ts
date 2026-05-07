import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { BrowserCreateTaskFromLinkIntent, ElectronAPI } from '@slayzone/types'
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
  dialog: {
    showOpenDialog: (options) => ipcRenderer.invoke('dialog:showOpenDialog', options)
  },
  app: {
    getTrpcPort: () => ipcRenderer.invoke('app:get-trpc-port') as Promise<number>,
    isTestsPanelEnabledSync: ipcRenderer.sendSync('app:is-tests-panel-enabled-sync') as boolean,
    isJiraIntegrationEnabledSync: ipcRenderer.sendSync('app:is-jira-integration-enabled-sync') as boolean,
    isLoopModeEnabledSync: ipcRenderer.sendSync('app:is-loop-mode-enabled-sync') as boolean,
    isPlaywright: process.env.PLAYWRIGHT === '1',
    onGoHome: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('app:go-home', handler)
      return () => ipcRenderer.removeListener('app:go-home', handler)
    },
    onToggleAgentPanel: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('app:toggle-agent-panel', handler)
      return () => ipcRenderer.removeListener('app:toggle-agent-panel', handler)
    },
    onToggleAgentStatusPanel: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('app:toggle-agent-status-panel', handler)
      return () => ipcRenderer.removeListener('app:toggle-agent-status-panel', handler)
    },
    onOpenSettings: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('app:open-settings', handler)
      return () => ipcRenderer.removeListener('app:open-settings', handler)
    },
    onOpenProjectSettings: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('app:open-project-settings', handler)
      return () => ipcRenderer.removeListener('app:open-project-settings', handler)
    },
    onNewTemporaryTask: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('app:new-temporary-task', handler)
      return () => ipcRenderer.removeListener('app:new-temporary-task', handler)
    },
    onTasksChanged: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('tasks:changed', handler)
      return () => ipcRenderer.removeListener('tasks:changed', handler)
    },
    onSettingsChanged: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('settings:changed', handler)
      return () => ipcRenderer.removeListener('settings:changed', handler)
    },
    onCloseTask: (callback: (taskId: string) => void) => {
      const handler = (_: unknown, taskId: string) => callback(taskId)
      ipcRenderer.on('app:close-task', handler)
      return () => ipcRenderer.removeListener('app:close-task', handler)
    },
    onBrowserEnsurePanelOpen: (callback: (taskId: string, url?: string, tabId?: string) => void) => {
      const handler = (_: unknown, taskId: string, url?: string, tabId?: string) => callback(taskId, url, tabId)
      ipcRenderer.on('browser:ensure-panel-open', handler)
      return () => ipcRenderer.removeListener('browser:ensure-panel-open', handler)
    },
    onBrowserCreateTab: (
      callback: (payload: { taskId: string; tabId: string; url?: string; background?: boolean }) => void,
    ) => {
      const handler = (
        _: unknown,
        payload: { taskId: string; tabId: string; url?: string; background?: boolean },
      ) => callback(payload)
      ipcRenderer.on('browser:create-tab', handler)
      return () => ipcRenderer.removeListener('browser:create-tab', handler)
    },
    onOpenTask: (callback: (taskId: string) => void) => {
      const handler = (_: unknown, taskId: string) => callback(taskId)
      ipcRenderer.on('app:open-task', handler)
      return () => ipcRenderer.removeListener('app:open-task', handler)
    },
    onOpenArtifact: (callback: (taskId: string, artifactId: string) => void) => {
      const handler = (_: unknown, payload: { taskId: string; artifactId: string }) => callback(payload.taskId, payload.artifactId)
      ipcRenderer.on('app:open-artifact', handler)
      return () => ipcRenderer.removeListener('app:open-artifact', handler)
    },
    onScreenshotTrigger: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('app:screenshot-trigger', handler)
      return () => ipcRenderer.removeListener('app:screenshot-trigger', handler)
    },
    onCloseCurrent: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('app:close-current-focus', handler)
      return () => ipcRenderer.removeListener('app:close-current-focus', handler)
    },
    onSyncSessionId: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('app:sync-session-id', handler)
      return () => ipcRenderer.removeListener('app:sync-session-id', handler)
    },
    onReloadBrowser: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('app:reload-browser', handler)
      return () => ipcRenderer.removeListener('app:reload-browser', handler)
    },
    onReloadApp: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('app:reload-app', handler)
      return () => ipcRenderer.removeListener('app:reload-app', handler)
    },
    onZoomFactorChanged: (callback: (factor: number) => void) => {
      const handler = (_: unknown, factor: number) => callback(factor)
      ipcRenderer.on('app:zoom-factor-changed', handler)
      return () => ipcRenderer.removeListener('app:zoom-factor-changed', handler)
    },
    onCloseActiveTask: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('app:close-active-task', handler)
      return () => ipcRenderer.removeListener('app:close-active-task', handler)
    },
    onUpdateStatus: (callback) => {
      const handler = (_: unknown, status: import('@slayzone/types').UpdateStatus) => callback(status)
      ipcRenderer.on('app:update-status', handler)
      return () => ipcRenderer.removeListener('app:update-status', handler)
    },
    dataReady: () => ipcRenderer.send('app:data-ready'),
    // No-op in prod — only emits IPC when main is collecting boot timing.
    // Avoids per-cold-start IPC waste for an instrumentation hook.
    bootMark: process.env.SLAYZONE_DEBUG_BOOT === '1'
      ? (label: string) => ipcRenderer.send('boot:mark', label)
      : () => {},
  },
  taskWindow: {
    open: (taskId: string) => ipcRenderer.invoke('task-window:open', taskId),
    close: (taskId: string) => ipcRenderer.invoke('task-window:close', taskId),
    list: () => ipcRenderer.invoke('task-window:list'),
    onListChanged: (callback: (taskIds: string[]) => void) => {
      const handler = (_: unknown, ids: string[]) => callback(ids)
      ipcRenderer.on('task-window:list-changed', handler)
      return () => ipcRenderer.removeListener('task-window:list-changed', handler)
    },
    setPrimaryActive: (taskId: string | null) => ipcRenderer.invoke('task-window:set-primary-active', taskId),
    getPrimaryActive: () => ipcRenderer.invoke('task-window:get-primary-active'),
    onPrimaryActiveChanged: (callback: (taskId: string | null) => void) => {
      const handler = (_: unknown, id: string | null) => callback(id)
      ipcRenderer.on('task-window:primary-active-changed', handler)
      return () => ipcRenderer.removeListener('task-window:primary-active-changed', handler)
    }
  },
  panels: {
    claim: (taskId: string, panelId: string) => ipcRenderer.invoke('panels:claim', taskId, panelId),
    claimAndCloseOther: (taskId: string, panelId: string) => ipcRenderer.invoke('panels:claim-and-close-other', taskId, panelId),
    release: (taskId: string, panelId: string) => ipcRenderer.invoke('panels:release', taskId, panelId),
    releaseAllForTask: (taskId: string) => ipcRenderer.invoke('panels:release-all-for-task', taskId),
    getOwnership: (taskId: string) => ipcRenderer.invoke('panels:get-ownership', taskId),
    getWindowId: () => ipcRenderer.invoke('panels:get-window-id'),
    onOwnershipChanged: (callback: (payload: { taskId: string; ownership: Array<{ panelId: string; ownerWindowId: number }> }) => void) => {
      const handler = (_: unknown, payload: { taskId: string; ownership: Array<{ panelId: string; ownerWindowId: number }> }) => callback(payload)
      ipcRenderer.on('panels:ownership-changed', handler)
      return () => ipcRenderer.removeListener('panels:ownership-changed', handler)
    },
    onReleasedOnClose: (callback: (payload: { closedWindowId: number; released: Array<{ taskId: string; panelId: string }> }) => void) => {
      const handler = (_: unknown, payload: { closedWindowId: number; released: Array<{ taskId: string; panelId: string }> }) => callback(payload)
      ipcRenderer.on('panels:released-on-close', handler)
      return () => ipcRenderer.removeListener('panels:released-on-close', handler)
    },
    onCloseRequest: (callback: (payload: { taskId: string; panelId: string }) => void) => {
      const handler = (_: unknown, payload: { taskId: string; panelId: string }) => callback(payload)
      ipcRenderer.on('panels:close-request', handler)
      return () => ipcRenderer.removeListener('panels:close-request', handler)
    }
  },
  window: {
    close: () => ipcRenderer.invoke('window:close')
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
    claimSession: (sessionId: string) => ipcRenderer.invoke('pty:claim-session', sessionId),
    resize: (sessionId, cols, rows) => ipcRenderer.invoke('pty:resize', sessionId, cols, rows),
    kill: (sessionId) => ipcRenderer.invoke('pty:kill', sessionId),
    exists: (sessionId) => ipcRenderer.invoke('pty:exists', sessionId),
    getBuffer: (sessionId) => ipcRenderer.invoke('pty:getBuffer', sessionId),
    clearBuffer: (sessionId) => ipcRenderer.invoke('pty:clearBuffer', sessionId),
    getBufferSince: (sessionId, afterSeq) => ipcRenderer.invoke('pty:getBufferSince', sessionId, afterSeq),
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
  webview: {
    registerShortcuts: (webviewId) =>
      ipcRenderer.invoke('webview:register-shortcuts', webviewId),
    setKeyboardPassthrough: (webviewId, enabled) =>
      ipcRenderer.invoke('webview:set-keyboard-passthrough', webviewId, enabled),
    setDesktopHandoffPolicy: (webviewId, policy) =>
      ipcRenderer.invoke('webview:set-desktop-handoff-policy', webviewId, policy),
    onShortcut: (callback) => {
      const handler = (_event: unknown, payload: { key: string; shift?: boolean; webviewId?: number }) =>
        callback(payload)
      ipcRenderer.on('webview:shortcut', handler)
      return () => ipcRenderer.removeListener('webview:shortcut', handler)
    },
    openDevToolsBottom: (webviewId) =>
      ipcRenderer.invoke('webview:open-devtools-bottom', webviewId),
    openDevToolsDetached: (webviewId) =>
      ipcRenderer.invoke('webview:open-devtools-detached', webviewId),
    closeDevTools: (webviewId) =>
      ipcRenderer.invoke('webview:close-devtools', webviewId),
    isDevToolsOpened: (webviewId) =>
      ipcRenderer.invoke('webview:is-devtools-opened', webviewId),
    enableDeviceEmulation: (webviewId, params) =>
      ipcRenderer.invoke('webview:enable-device-emulation', webviewId, params),
    disableDeviceEmulation: (webviewId) =>
      ipcRenderer.invoke('webview:disable-device-emulation', webviewId),
    registerBrowserTab: (taskId, tabId, webContentsId) =>
      ipcRenderer.invoke('webview:register-browser-tab', taskId, tabId, webContentsId),
    unregisterBrowserTab: (taskId, tabId) =>
      ipcRenderer.invoke('webview:unregister-browser-tab', taskId, tabId),
    setActiveBrowserTab: (taskId, tabId) =>
      ipcRenderer.invoke('webview:set-active-browser-tab', taskId, tabId),
  },
  browser: {
    // Subscription-style methods kept as IPC — backed by webContents.send from
    // browser-view-manager. Migration would require routing events through tRPC subs.
    onBrowserViewShortcut: (cb) => {
      const handler = (_event: unknown, data: { viewId: string; key: string; shift: boolean; alt: boolean; meta: boolean; control: boolean; kind?: string }) => cb(data)
      ipcRenderer.on('browser-view:shortcut', handler)
      return () => ipcRenderer.removeListener('browser-view:shortcut', handler)
    },
    onBrowserViewFocused: (cb) => {
      const handler = (_event: unknown, data: { viewId: string }) => cb(data)
      ipcRenderer.on('browser-view:focused', handler)
      return () => ipcRenderer.removeListener('browser-view:focused', handler)
    },
    onCreateTaskFromLink: (cb) => {
      const handler = (_event: unknown, intent: BrowserCreateTaskFromLinkIntent) => cb(intent)
      ipcRenderer.on('browser:create-task-from-link', handler)
      return () => ipcRenderer.removeListener('browser:create-task-from-link', handler)
    },
    onEvent: (cb) => {
      const handler = (_event: unknown, data: { viewId: string; type: string; [key: string]: unknown }) => cb(data)
      ipcRenderer.on('browser:event', handler)
      return () => ipcRenderer.removeListener('browser:event', handler)
    },
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
