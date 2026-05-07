// App-level dependencies that the router needs. The Electron-main host calls
// setAppDeps() at startup with concrete implementations; standalone server
// runs without these and procedures throw NOT_FOUND.

import type { BackupInfo, BackupSettings, LocalLeaderboardStats, ProcessInfo, ProcessStatus, ProcessStats } from '@slayzone/types'
import type { ProviderUsage, UsageProviderConfig, UsageWindow } from '@slayzone/terminal/shared'
import type { EventEmitter } from 'node:events'

export type AppDeps = {
  // backup
  backupList: () => BackupInfo[]
  backupCreate: (name?: string) => Promise<BackupInfo>
  backupRename: (filename: string, name: string) => void
  backupDelete: (filename: string) => void
  backupRestore: (filename: string) => void
  backupGetSettings: () => BackupSettings
  backupSetSettings: (partial: Partial<BackupSettings>) => BackupSettings
  backupRevealInFinder: () => void

  // clipboard
  clipboardWriteFilePaths: (paths: string[]) => void
  clipboardReadFilePaths: () => string[]
  clipboardHasFiles: () => boolean

  // screenshot
  screenshotCaptureView: (viewId: string) => Promise<{ success: boolean; path?: string }>

  // leaderboard
  leaderboardGetLocalStats: () => Promise<LocalLeaderboardStats>

  // export-import
  exportAll: () => Promise<{ success: boolean; canceled?: boolean; path?: string; error?: string }>
  exportProject: (projectId: string) => Promise<{ success: boolean; canceled?: boolean; path?: string; error?: string }>
  importBundle: () => Promise<{ success: boolean; canceled?: boolean; projectCount?: number; taskCount?: number; importedProjects?: Array<{ id: string; name: string }>; error?: string }>
  testExportAllToPath?: (filePath: string) => { success: boolean; path?: string; error?: string }
  testExportProjectToPath?: (projectId: string, filePath: string) => { success: boolean; path?: string; error?: string }
  testImportFromPath?: (filePath: string) => unknown
  testSetTaskParent?: (taskId: string, parentId: string | null) => { success: boolean; error?: string }

  // usage
  usageFetch: (force?: boolean) => Promise<ProviderUsage[]>
  usageTest: (config: UsageProviderConfig) => Promise<{ ok: boolean; windows?: UsageWindow[]; error?: string }>

  // files
  filesPathExists: (filePath: string) => Promise<boolean>
  filesSaveTempImage: (base64: string, mimeType: string) => Promise<{ success: boolean; path?: string; error?: string }>

  // shell
  shellOpenExternal: (url: string, options?: { blockDesktopHandoff?: boolean; desktopHandoff?: { protocol?: string; hostScope?: string } }) => void
  shellOpenPath: (absPath: string) => Promise<string>

  // app metadata
  appGetVersion: () => string
  appGetTrpcPort: () => Promise<number>
  appIsTestsPanelEnabled: () => boolean
  appIsJiraIntegrationEnabled: () => boolean
  appIsLoopModeEnabled: () => boolean
  appGetZoomFactor: () => number
  appCheckCliInstalled: () => { installed: boolean; path?: string; mode?: string; error?: string } | Promise<{ installed: boolean; path?: string; mode?: string; error?: string }>
  appInstallCli: () => Promise<{ ok: boolean; path?: string; error?: string; pathNotInPATH?: boolean; elevationCancelled?: boolean; permissionDenied?: boolean }>
  appAdjustZoom: (command: 'in' | 'out' | 'reset') => number
  appRestartForUpdate: () => void
  appCheckForUpdates: () => Promise<void>
  appGetProtocolClientStatus: () => { scheme: string; attempted: boolean; registered: boolean; reason: 'registered' | 'dev-skipped' | 'registration-failed' }
  appGetRendererZoomFactor: () => number | null
  appWindowGetContentBounds: () => { x: number; y: number; width: number; height: number } | null
  appWindowGetDisplayScaleFactor: () => number
  authGithubSystemSignIn: (input: { convexUrl: string; redirectTo: string }) => Promise<unknown>

  // Browser view manager — heavy electron coupling, expose as opaque object
  // and call methods directly from procedures. All return types are unknown
  // since the manager's public surface evolves; callers cast on the renderer.
  browser: {
    createView: (opts: unknown) => unknown
    destroyView: (viewId: string) => unknown
    destroyAllForTask: (taskId: string) => unknown
    setBounds: (viewId: string, bounds: unknown) => unknown
    setVisible: (viewId: string, visible: boolean) => unknown
    hideAll: () => unknown
    showAll: () => unknown
    setHandoffPolicy: (viewId: string, policy: unknown) => unknown
    navigate: (viewId: string, url: string) => unknown
    goBack: (viewId: string) => unknown
    goForward: (viewId: string) => unknown
    reload: (viewId: string, ignoreCache?: boolean) => unknown
    stop: (viewId: string) => unknown
    executeJs: (viewId: string, code: string) => unknown
    insertCss: (viewId: string, css: string) => unknown
    removeCss: (viewId: string, key: string) => unknown
    setZoom: (viewId: string, factor: number) => unknown
    focus: (viewId: string) => unknown
    findInPage: (viewId: string, text: string, options?: unknown) => unknown
    stopFindInPage: (viewId: string, action: 'clearSelection' | 'keepSelection' | 'activateSelection') => unknown
    setKeyboardPassthrough: (viewId: string, enabled: boolean) => unknown
    sendInputEvent: (viewId: string, input: unknown) => unknown
    openDevTools: (viewId: string, mode: 'bottom' | 'right' | 'undocked' | 'detach') => unknown
    closeDevTools: (viewId: string) => unknown
    isDevToolsOpen: (viewId: string) => unknown
    getUrl: (viewId: string) => unknown
    getBounds: (viewId: string) => unknown
    getZoomFactor: (viewId: string) => unknown
    getActualNativeBounds: (viewId: string) => unknown
    getViewVisible: (viewId: string) => unknown
    getViewsForTask: (taskId: string) => unknown
    getAllViewIds: () => unknown
    listViews: () => unknown
    getNativeChildViewCount: () => unknown
    isAllHidden: () => unknown
    isFocused: (viewId: string) => unknown
    isViewNativelyVisible: (viewId: string) => unknown
    getPartition: (viewId: string) => unknown
    getWebContentsId: (viewId: string) => unknown
    activateExtension: (extensionId: string) => unknown
    getExtensions: () => unknown
    loadExtension: () => unknown
    removeExtension: (extensionId: string) => unknown
    discoverBrowserExtensions: () => unknown
    importExtension: (extPath: string) => unknown
    reparentToCurrentWindow: (viewId: string) => unknown
  }
  floatingAgent: {
    setEnabled: (enabled: boolean) => unknown
    setSessionId: (sessionId: string | null) => unknown
    setPanelOpen: (isOpen: boolean) => unknown
    toggleCollapse: () => unknown
    resetSize: () => unknown
    detach: () => unknown
    reattach: () => unknown
    getState: () => unknown
    getSession: () => unknown
    getConfig: () => unknown
    events: EventEmitter & {
      on(event: 'state', listener: (payload: unknown) => void): EventEmitter
      on(event: 'session-changed', listener: () => void): EventEmitter
      on(event: 'collapse-changed', listener: (collapsed: boolean) => void): EventEmitter
      off(event: string, listener: (...args: unknown[]) => void): EventEmitter
    }
  }
  webview: {
    registerBrowserTab: (taskId: string, tabId: string, webContentsId: number) => void
    unregisterBrowserTab: (taskId: string, tabId: string) => void
    setActiveBrowserTab: (taskId: string, tabId: string | null) => void
    registerShortcuts: (webviewId: number) => void
    setKeyboardPassthrough: (webviewId: number, enabled: boolean) => void
    setDesktopHandoffPolicy: (webviewId: number, policy: unknown) => boolean
    openDevToolsBottom: (webviewId: number, options?: { probe?: boolean }) => Promise<boolean>
    openDevToolsDetached: (webviewId: number) => Promise<boolean>
    closeDevTools: (webviewId: number) => Promise<boolean>
    isDevToolsOpened: (webviewId: number) => boolean
    disableDeviceEmulation: (webviewId: number) => boolean
  }

  // db:feedback (6 ops — pure DB)
  feedbackListThreads: () => unknown
  feedbackCreateThread: (input: { id: string; title: string; discord_thread_id: string | null }) => void
  feedbackGetMessages: (threadId: string) => unknown
  feedbackAddMessage: (input: { id: string; thread_id: string; content: string }) => void
  feedbackUpdateThreadDiscordId: (threadId: string, discordThreadId: string) => void
  feedbackDeleteThread: (threadId: string) => void
}

let appDeps: AppDeps | null = null

export function setAppDeps(deps: AppDeps): void {
  appDeps = deps
}

export function getAppDeps(): AppDeps {
  if (!appDeps) throw new Error('appDeps not initialized — call setAppDeps() in main host first')
  return appDeps
}

// Pty deps
import type { TerminalState } from '@slayzone/terminal/shared'
import type { createPtyOps, createChatOps, createChatQueueOps } from '@slayzone/terminal/electron'

export type PtyDeps = {
  ops: ReturnType<typeof createPtyOps>
  events: EventEmitter & {
    on(event: 'data', listener: (sessionId: string, data: string, seq: number) => void): EventEmitter
    on(event: 'state-change', listener: (sessionId: string, newState: TerminalState, oldState: TerminalState) => void): EventEmitter
    on(event: 'title-change', listener: (sessionId: string, title: string) => void): EventEmitter
    on(event: 'exit', listener: (sessionId: string, exitCode: number | null) => void): EventEmitter
    on(event: 'prompt', listener: (sessionId: string, prompt: unknown) => void): EventEmitter
    on(event: 'session-detected', listener: (sessionId: string, conversationId: string) => void): EventEmitter
    on(event: 'session-not-found', listener: (sessionId: string) => void): EventEmitter
    on(event: 'dev-server-detected', listener: (sessionId: string, info: unknown) => void): EventEmitter
    on(event: 'respawn-suggested', listener: (taskId: string) => void): EventEmitter
    on(event: 'respawn-forced', listener: (taskId: string, reqId: string) => void): EventEmitter
    off(event: string, listener: (...args: unknown[]) => void): EventEmitter
  }
}

let ptyDeps: PtyDeps | null = null
export function setPtyDeps(deps: PtyDeps): void { ptyDeps = deps }
export function getPtyDeps(): PtyDeps {
  if (!ptyDeps) throw new Error('ptyDeps not initialized')
  return ptyDeps
}

// Chat deps
export type ChatDeps = {
  ops: ReturnType<typeof createChatOps>
  queueOps: ReturnType<typeof createChatQueueOps>
  events: EventEmitter & {
    on(event: 'event', listener: (tabId: string, agentEvent: unknown, seq: number) => void): EventEmitter
    on(event: 'exit', listener: (tabId: string, sessionId: string, code: number | null, signal: string | null) => void): EventEmitter
    off(event: string, listener: (...args: unknown[]) => void): EventEmitter
  }
  queueEvents: EventEmitter & {
    on(event: 'queue-changed', listener: (tabId: string) => void): EventEmitter
    on(event: 'queue-drained', listener: (tabId: string, original: string) => void): EventEmitter
    off(event: string, listener: (...args: unknown[]) => void): EventEmitter
  }
}

let chatDeps: ChatDeps | null = null
export function setChatDeps(deps: ChatDeps): void { chatDeps = deps }
export function getChatDeps(): ChatDeps {
  if (!chatDeps) throw new Error('chatDeps not initialized')
  return chatDeps
}

// Processes deps — lifecycle managed separately because EventEmitter must be live
export type ProcessesDeps = {
  create: (projectId: string | null, taskId: string | null, label: string, command: string, cwd: string, autoRestart: boolean) => string | Promise<string>
  spawn: (projectId: string | null, taskId: string | null, label: string, command: string, cwd: string, autoRestart: boolean) => string | Promise<string>
  update: (processId: string, updates: Partial<Pick<ProcessInfo, 'label' | 'command' | 'cwd' | 'autoRestart' | 'taskId' | 'projectId'>>) => boolean
  stop: (processId: string) => boolean | Promise<boolean>
  kill: (processId: string) => boolean | Promise<boolean>
  restart: (processId: string) => boolean | Promise<boolean>
  listForTask: (taskId: string | null, projectId: string | null) => ProcessInfo[]
  listAll: () => ProcessInfo[]
  killTask: (taskId: string) => void
  events: EventEmitter & {
    on(event: 'log', listener: (id: string, line: string) => void): EventEmitter
    on(event: 'status', listener: (id: string, status: ProcessStatus) => void): EventEmitter
    on(event: 'title', listener: (id: string, title: string | null) => void): EventEmitter
    on(event: 'stats', listener: (stats: Record<string, ProcessStats>) => void): EventEmitter
    off(event: string, listener: (...args: unknown[]) => void): EventEmitter
  }
}

let processesDeps: ProcessesDeps | null = null

export function setProcessesDeps(deps: ProcessesDeps): void {
  processesDeps = deps
}

export function getProcessesDeps(): ProcessesDeps {
  if (!processesDeps) throw new Error('processesDeps not initialized — call setProcessesDeps() in main host first')
  return processesDeps
}
