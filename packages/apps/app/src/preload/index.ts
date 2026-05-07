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
  auth: {
    githubSystemSignIn: (input: { convexUrl: string; redirectTo: string }) =>
      ipcRenderer.invoke('auth:github-system-sign-in', input)
  },
  dialog: {
    showOpenDialog: (options) => ipcRenderer.invoke('dialog:showOpenDialog', options)
  },
  app: {
    getProtocolClientStatus: () => ipcRenderer.invoke('app:get-protocol-client-status'),
    getTrpcPort: () => ipcRenderer.invoke('app:get-trpc-port') as Promise<number>,
    isTestsPanelEnabledSync: ipcRenderer.sendSync('app:is-tests-panel-enabled-sync') as boolean,
    isJiraIntegrationEnabledSync: ipcRenderer.sendSync('app:is-jira-integration-enabled-sync') as boolean,
    isLoopModeEnabledSync: ipcRenderer.sendSync('app:is-loop-mode-enabled-sync') as boolean,
    adjustZoom: (command: 'in' | 'out' | 'reset') => ipcRenderer.invoke('app:adjust-zoom', command) as Promise<number>,
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
    restartForUpdate: () => ipcRenderer.invoke('app:restart-for-update'),
    checkForUpdates: () => ipcRenderer.invoke('app:check-for-updates'),
  },
  floatingAgent: {
    setEnabled: (enabled: boolean) => ipcRenderer.invoke('floating-agent:set-enabled', enabled),
    setSessionId: (sessionId: string | null) => ipcRenderer.invoke('floating-agent:set-session-id', sessionId),
    setPanelOpen: (isOpen: boolean) => ipcRenderer.invoke('floating-agent:set-panel-open', isOpen),
    toggleCollapse: () => ipcRenderer.invoke('floating-agent:toggle-collapse'),
    resetSize: () => ipcRenderer.invoke('floating-agent:reset-size'),
    detach: () => ipcRenderer.invoke('floating-agent:detach'),
    reattach: () => ipcRenderer.invoke('floating-agent:reattach'),
    getState: () => ipcRenderer.invoke('floating-agent:get-state'),
    getSession: () => ipcRenderer.invoke('floating-agent:get-session'),
    getConfig: () => ipcRenderer.invoke('floating-agent:get-config'),
    onState: (callback: (state: { kind: string; sessionId: string | null; mode: 'auto' | 'manual' | null; hasCustomSize: boolean }) => void) => {
      const handler = (_: unknown, state: { kind: string; sessionId: string | null; mode: 'auto' | 'manual' | null; hasCustomSize: boolean }) => callback(state)
      ipcRenderer.on('floating-agent:state', handler)
      return () => ipcRenderer.removeListener('floating-agent:state', handler)
    },
    onSessionChanged: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('floating-agent:session-changed', handler)
      return () => ipcRenderer.removeListener('floating-agent:session-changed', handler)
    },
    onCollapseChanged: (callback: (collapsed: boolean) => void) => {
      const handler = (_: unknown, collapsed: boolean) => callback(collapsed)
      ipcRenderer.on('floating-agent:collapse-changed', handler)
      return () => ipcRenderer.removeListener('floating-agent:collapse-changed', handler)
    },
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
  chat: {
    supports: (mode: string) => ipcRenderer.invoke('chat:supports', mode),
    create: (opts: { tabId: string; taskId: string; mode: string; cwd: string; providerFlagsOverride?: string | null }) =>
      ipcRenderer.invoke('chat:create', opts),
    send: (tabId: string, text: string) => ipcRenderer.invoke('chat:send', tabId, text),
    sendToolResult: (
      tabId: string,
      args: { toolUseId: string; content: string; isError?: boolean }
    ) => ipcRenderer.invoke('chat:sendToolResult', tabId, args),
    respondPermission: (
      tabId: string,
      args: {
        requestId: string
        decision:
          | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }
          | { behavior: 'deny'; message: string; interrupt?: boolean }
      }
    ) => ipcRenderer.invoke('chat:respondPermission', tabId, args),
    interrupt: (opts: { tabId: string; taskId: string; mode: string; cwd: string; providerFlagsOverride?: string | null }) =>
      ipcRenderer.invoke('chat:interrupt', opts),
    abortAndPop: (opts: { tabId: string; taskId: string; mode: string; cwd: string; providerFlagsOverride?: string | null }) =>
      ipcRenderer.invoke('chat:abortAndPop', opts),
    kill: (tabId: string) => ipcRenderer.invoke('chat:kill', tabId),
    remove: (tabId: string) => ipcRenderer.invoke('chat:remove', tabId),
    reset: (opts: { tabId: string; taskId: string; mode: string; cwd: string; providerFlagsOverride?: string | null }) =>
      ipcRenderer.invoke('chat:reset', opts),
    getBufferSince: (tabId: string, afterSeq: number) =>
      ipcRenderer.invoke('chat:getBufferSince', tabId, afterSeq),
    getInfo: (tabId: string) => ipcRenderer.invoke('chat:getInfo', tabId),
    inspectPermissions: (taskId: string, mode: string) =>
      ipcRenderer.invoke('chat:inspectPermissions', taskId, mode),
    getMode: (taskId: string, mode: string) =>
      ipcRenderer.invoke('chat:getMode', taskId, mode),
    setMode: (opts: { tabId: string; taskId: string; mode: string; cwd: string; chatMode: 'plan' | 'auto-accept' | 'auto' | 'bypass' }) =>
      ipcRenderer.invoke('chat:setMode', opts),
    getModel: (taskId: string, mode: string) =>
      ipcRenderer.invoke('chat:getModel', taskId, mode),
    setModel: (opts: { tabId: string; taskId: string; mode: string; cwd: string; chatModel: 'sonnet' | 'opus' | 'haiku' }) =>
      ipcRenderer.invoke('chat:setModel', opts),
    getEffort: (taskId: string, mode: string) =>
      ipcRenderer.invoke('chat:getEffort', taskId, mode),
    setEffort: (opts: { tabId: string; taskId: string; mode: string; cwd: string; chatEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' }) =>
      ipcRenderer.invoke('chat:setEffort', opts),
    getAutoEligibility: () => ipcRenderer.invoke('chat:getAutoEligibility'),
    list: () => ipcRenderer.invoke('chat:list'),
    listSkills: (cwd: string) => ipcRenderer.invoke('chat:listSkills', cwd),
    listCommands: (cwd: string) => ipcRenderer.invoke('chat:listCommands', cwd),
    listAgents: (cwd: string) => ipcRenderer.invoke('chat:listAgents', cwd),
    listFiles: (cwd: string, query: string, limit?: number) =>
      ipcRenderer.invoke('chat:listFiles', cwd, query, limit),
    bumpAutocompleteUsage: (source: string, name: string) =>
      ipcRenderer.invoke('chat:bumpAutocompleteUsage', source, name),
    getAutocompleteUsage: () => ipcRenderer.invoke('chat:getAutocompleteUsage'),
    onEvent: ((callback: (tabId: string, event: unknown, seq: number) => void) => {
      const handler = (_e: unknown, tabId: string, event: unknown, seq: number) =>
        callback(tabId, event, seq)
      ipcRenderer.on('chat:event', handler)
      return () => {
        ipcRenderer.removeListener('chat:event', handler)
      }
    }) as ElectronAPI['chat']['onEvent'],
    onExit: (
      callback: (
        tabId: string,
        sessionId: string,
        code: number | null,
        signal: string | null
      ) => void
    ) => {
      const handler = (
        _e: unknown,
        tabId: string,
        sessionId: string,
        code: number | null,
        signal: string | null
      ): void => callback(tabId, sessionId, code, signal)
      ipcRenderer.on('chat:exit', handler)
      return () => {
        ipcRenderer.removeListener('chat:exit', handler)
      }
    },
  },
  chatQueue: {
    list: (tabId: string) => ipcRenderer.invoke('chat:queue:list', tabId),
    push: (tabId: string, send: string, original: string) =>
      ipcRenderer.invoke('chat:queue:push', tabId, send, original),
    remove: (id: string) => ipcRenderer.invoke('chat:queue:remove', id),
    clear: (tabId: string) => ipcRenderer.invoke('chat:queue:clear', tabId),
    onChanged: (callback: (tabId: string) => void) => {
      const handler = (_: unknown, tabId: string) => callback(tabId)
      ipcRenderer.on('chat:queue-changed', handler)
      return () => ipcRenderer.removeListener('chat:queue-changed', handler)
    },
    onDrained: (callback: (tabId: string, original: string) => void) => {
      const handler = (_: unknown, tabId: string, original: string) => callback(tabId, original)
      ipcRenderer.on('chat:queue-drained', handler)
      return () => ipcRenderer.removeListener('chat:queue-drained', handler)
    },
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
    createView: (opts) => ipcRenderer.invoke('browser:create-view', opts),
    reparentToCurrentWindow: (viewId: string) => ipcRenderer.invoke('browser:reparent-to-current-window', viewId),
    destroyView: (viewId) => ipcRenderer.invoke('browser:destroy-view', viewId),
    destroyAllForTask: (taskId) => ipcRenderer.invoke('browser:destroy-all-for-task', taskId),
    listViews: () => ipcRenderer.invoke('browser:list-views'),
    setBounds: (viewId, bounds) => ipcRenderer.invoke('browser:set-bounds', viewId, bounds),
    setVisible: (viewId, visible) => ipcRenderer.invoke('browser:set-visible', viewId, visible),
    hideAll: () => ipcRenderer.invoke('browser:hide-all'),
    showAll: () => ipcRenderer.invoke('browser:show-all'),
    setHandoffPolicy: (viewId, policy) => ipcRenderer.invoke('browser:set-handoff-policy', viewId, policy),
    navigate: (viewId, url) => ipcRenderer.invoke('browser:navigate', viewId, url),
    goBack: (viewId) => ipcRenderer.invoke('browser:go-back', viewId),
    goForward: (viewId) => ipcRenderer.invoke('browser:go-forward', viewId),
    reload: (viewId, ignoreCache) => ipcRenderer.invoke('browser:reload', viewId, ignoreCache),
    stop: (viewId) => ipcRenderer.invoke('browser:stop', viewId),
    executeJs: (viewId, code) => ipcRenderer.invoke('browser:execute-js', viewId, code),
    insertCss: (viewId, css) => ipcRenderer.invoke('browser:insert-css', viewId, css),
    removeCss: (viewId, key) => ipcRenderer.invoke('browser:remove-css', viewId, key),
    setZoom: (viewId, factor) => ipcRenderer.invoke('browser:set-zoom', viewId, factor),
    focus: (viewId) => ipcRenderer.invoke('browser:focus', viewId),
    findInPage: (viewId, text, options) => ipcRenderer.invoke('browser:find-in-page', viewId, text, options),
    stopFindInPage: (viewId, action) => ipcRenderer.invoke('browser:stop-find-in-page', viewId, action),
    getWebContentsId: (viewId) => ipcRenderer.invoke('browser:get-web-contents-id', viewId),
    setKeyboardPassthrough: (viewId, enabled) => ipcRenderer.invoke('browser:set-keyboard-passthrough', viewId, enabled),
    sendInputEvent: (viewId, input) => ipcRenderer.invoke('browser:send-input-event', viewId, input),
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
    openDevTools: (viewId, mode) => ipcRenderer.invoke('browser:open-devtools', viewId, mode),
    closeDevTools: (viewId) => ipcRenderer.invoke('browser:close-devtools', viewId),
    isDevToolsOpen: (viewId) => ipcRenderer.invoke('browser:is-devtools-open', viewId),
    getExtensions: () => ipcRenderer.invoke('browser:get-extensions'),
    loadExtension: () => ipcRenderer.invoke('browser:load-extension'),
    removeExtension: (extensionId) => ipcRenderer.invoke('browser:remove-extension', extensionId),
    discoverBrowserExtensions: () => ipcRenderer.invoke('browser:discover-browser-extensions'),
    importExtension: (path) => ipcRenderer.invoke('browser:import-extension', path),
    activateExtension: (extensionId) => ipcRenderer.invoke('browser:activate-extension', extensionId),
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
