// App-level dependencies that the router needs but cannot import directly.
//
// The chat ops live in `@slayzone/terminal/main`, which lazily `require`s
// `electron` and pulls in `node-pty` — both forbidden inside the transport
// package (it must run under plain Node for the standalone `@slayzone/server`
// host). So we `import type` only (erased at build → zero electron at runtime)
// and the Electron-main host injects the concrete instances at startup via
// `setChatDeps()`. A standalone server without these wired would throw on the
// first chat procedure call.

import type { EventEmitter } from 'node:events'
import type { TypedEmitter } from '@slayzone/platform/events'
import type { CliInstallResult } from '@slayzone/platform'
import type {
  createChatOps,
  createChatQueueOps,
  ChatEventMap,
  ChatQueueEventMap,
  createPtyOps,
  PtyEventMap
} from '@slayzone/terminal/main'
import type { IntegrationOps } from '@slayzone/integrations/main'
import type { TaskOps } from '@slayzone/task/main'
import type {
  BackupInfo,
  BackupSettings,
  LocalLeaderboardStats,
  ProcessInfo,
  ProcessEventMap
} from '@slayzone/types'
import type { ProviderUsage, UsageProviderConfig, UsageWindow } from '@slayzone/terminal/shared'

// Chat deps — ops + queue ops + the two streaming emitters the subscriptions
// subscribe to. Same instances back the IPC handlers (coexistence until slice 5).
export type ChatDeps = {
  ops: ReturnType<typeof createChatOps>
  queueOps: ReturnType<typeof createChatQueueOps>
  events: TypedEmitter<ChatEventMap>
  queueEvents: TypedEmitter<ChatQueueEventMap>
}

let chatDeps: ChatDeps | null = null

export function setChatDeps(deps: ChatDeps): void {
  chatDeps = deps
}

export function getChatDeps(): ChatDeps {
  if (!chatDeps) throw new Error('chatDeps not initialized — call setChatDeps() in main host first')
  return chatDeps
}

// Pty deps — ops + the single streaming emitter the pty subscriptions subscribe
// to. `createPtyOps`/`ptyEvents` live in `@slayzone/terminal/main` (electron +
// node-pty), so `import type` only here; the Electron-main host injects the
// concrete instances via `setPtyDeps()`. Same instances back the IPC handlers
// (coexistence until slice 5).
export type PtyDeps = {
  ops: ReturnType<typeof createPtyOps>
  events: TypedEmitter<PtyEventMap>
}

let ptyDeps: PtyDeps | null = null

export function setPtyDeps(deps: PtyDeps): void {
  ptyDeps = deps
}

export function getPtyDeps(): PtyDeps {
  if (!ptyDeps) throw new Error('ptyDeps not initialized — call setPtyDeps() in main host first')
  return ptyDeps
}

// Integration ops — the electron-coupled domain ops (`@slayzone/integrations/main`
// pulls electron + node clients), injected by the host so the `integrationsRouter`
// and the still-live IPC handlers share one instance (coexistence until slice 5).
let integrationOps: IntegrationOps | null = null

export function setIntegrationOps(ops: IntegrationOps): void {
  integrationOps = ops
}

export function getIntegrationOps(): IntegrationOps {
  if (!integrationOps)
    throw new Error('integrationOps not initialized — call setIntegrationOps() in main host first')
  return integrationOps
}

// Task CRUD/deps/board ops — electron-coupled (`createTaskOp` pulls
// `@slayzone/worktrees/main` → electron). `import type` only here (erased at build →
// zero electron at runtime); the Electron-main host injects the concrete bundle via
// `setTaskDeps()` so the `task` router and the still-live IPC handlers share one
// implementation (coexistence until slice 5). The artifacts/template stores are
// electron-free and imported directly by their routers — not injected.
let taskOps: TaskOps | null = null

export function setTaskDeps(deps: { ops: TaskOps }): void {
  taskOps = deps.ops
}

export function getTaskOps(): TaskOps {
  if (!taskOps)
    throw new Error('taskOps not initialized — call setTaskDeps() in main host first')
  return taskOps
}

// Notify event bus — the cross-domain `tasks-changed` / `settings-changed`
// signals that back the `notify.*` subscriptions. The emitter is owned by the
// Electron-main host (`notify-renderer.ts`, which also drives the legacy IPC
// broadcast), injected here so the `notifyRouter` and the still-live
// `webContents.send` broadcast share one instance (coexistence until slice 5).
// `NotifyEventMap` lives transport-side because transport cannot import from
// `apps/app` (apps depend on packages, not vice-versa); the host conforms to it.
export type NotifyEventMap = {
  /** Any task data mutation — renderer refetches the board. No payload. */
  'tasks-changed': []
  /** Settings changed — renderer refetches affected config. No payload. */
  'settings-changed': []
}

let notifyEvents: TypedEmitter<NotifyEventMap> | null = null

export function setNotifyEvents(ev: TypedEmitter<NotifyEventMap>): void {
  notifyEvents = ev
}

export function getNotifyEvents(): TypedEmitter<NotifyEventMap> {
  if (!notifyEvents)
    throw new Error('notifyEvents not initialized — call setNotifyEvents() in main host first')
  return notifyEvents
}

// App-level ops — the grab-bag of main-process capabilities (backup, clipboard,
// screenshot, leaderboard, export/import, usage, …) that the `app` router wraps.
// Each is electron- or DB-coupled, so `import type` only here; the Electron-main
// host injects concrete impls via `setAppDeps()`. Same impls back the still-live
// IPC handlers (coexistence until slice 5). Signatures are Promise-typed because
// main's `SlayzoneDb` is async (worker_thread). A standalone server without these
// wired throws on the first app procedure call.
export type AppDeps = {
  // backup
  backupList: () => Promise<BackupInfo[]>
  backupCreate: (name?: string) => Promise<BackupInfo>
  backupRename: (filename: string, name: string) => Promise<void>
  backupDelete: (filename: string) => Promise<void>
  backupRestore: (filename: string) => Promise<void>
  backupGetSettings: () => Promise<BackupSettings>
  backupSetSettings: (partial: Partial<BackupSettings>) => Promise<BackupSettings>
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
  exportProject: (
    projectId: string
  ) => Promise<{ success: boolean; canceled?: boolean; path?: string; error?: string }>
  importBundle: () => Promise<{
    success: boolean
    canceled?: boolean
    projectCount?: number
    taskCount?: number
    importedProjects?: Array<{ id: string; name: string }>
    error?: string
  }>
  testExportAllToPath?: (
    filePath: string
  ) => Promise<{ success: boolean; path?: string; error?: string }>
  testExportProjectToPath?: (
    projectId: string,
    filePath: string
  ) => Promise<{ success: boolean; path?: string; error?: string }>
  testImportFromPath?: (filePath: string) => Promise<{
    success: boolean
    canceled?: boolean
    projectCount?: number
    taskCount?: number
    importedProjects?: Array<{ id: string; name: string }>
    error?: string
  }>
  testSetTaskParent?: (
    taskId: string,
    parentId: string | null
  ) => Promise<{ success: boolean; error?: string }>

  // usage
  usageFetch: (force?: boolean) => Promise<ProviderUsage[]>
  usageTest: (
    config: UsageProviderConfig
  ) => Promise<{ ok: boolean; windows?: UsageWindow[]; error?: string }>

  // files
  filesPathExists: (filePath: string) => Promise<boolean>
  filesSaveTempImage: (
    base64: string,
    mimeType: string
  ) => Promise<{ success: boolean; path?: string; error?: string }>

  // shell
  shellOpenExternal: (
    url: string,
    options?: {
      blockDesktopHandoff?: boolean
      desktopHandoff?: { protocol?: string; hostScope?: string }
    }
  ) => void
  shellOpenPath: (absPath: string) => Promise<string>

  // db:feedback (6 ops — pure DB). Threads/messages typed as `unknown` so
  // transport stays decoupled from @slayzone/feedback (host conforms via casts).
  feedbackListThreads: () => Promise<unknown>
  feedbackCreateThread: (input: {
    id: string
    title: string
    discord_thread_id: string | null
  }) => Promise<void>
  feedbackGetMessages: (threadId: string) => Promise<unknown>
  feedbackAddMessage: (input: {
    id: string
    thread_id: string
    content: string
  }) => Promise<void>
  feedbackUpdateThreadDiscordId: (threadId: string, discordThreadId: string) => Promise<void>
  feedbackDeleteThread: (threadId: string) => Promise<void>

  // app metadata (read-only)
  appGetVersion: () => string
  appGetTrpcPort: () => Promise<number>
  appIsTestsPanelEnabled: () => boolean
  appIsLoopModeEnabled: () => boolean
  appGetZoomFactor: () => number
  appGetProtocolClientStatus: () => {
    scheme: string
    attempted: boolean
    registered: boolean
    reason: 'registered' | 'dev-skipped' | 'registration-failed'
  }
  appGetRendererZoomFactor: () => number | null
  appCheckCliInstalled: () => { installed: boolean; path?: string }
  appInstallCli: () => Promise<CliInstallResult>
  appAdjustZoom: (command: 'in' | 'out' | 'reset') => number
  appRestartForUpdate: () => Promise<void>
  appCheckForUpdates: () => Promise<void>

  // window
  appWindowGetContentBounds: () => {
    x: number
    y: number
    width: number
    height: number
  } | null
  appWindowGetDisplayScaleFactor: () => number | null

  // auth
  authGithubSystemSignIn: (input: { convexUrl: string; redirectTo: string }) => Promise<unknown>

  // dialog (native file picker — same electron dialog API backs the
  // `dialog:showOpenDialog` IPC handler; coexistence until slice 5)
  dialogShowOpenDialog: (options: unknown) => Promise<{ canceled: boolean; filePaths: string[] }>

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
    stopFindInPage: (
      viewId: string,
      action: 'clearSelection' | 'keepSelection' | 'activateSelection'
    ) => unknown
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

  // Floating global agent panel — ops + the 3 streaming emitters the
  // floatingAgent subscriptions consume. Same instances back the
  // `floating-global-agent-panel:*` IPC handlers (coexistence until slice 5).
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

  // Webview — CLI tab registry (P19i) + devtools (P19k) + shortcuts/emulation
  // (P19m). Same impls back the `webview:*` IPC handlers (coexistence/slice 5).
  webview: {
    registerBrowserTab: (taskId: string, tabId: string, webContentsId: number) => void
    unregisterBrowserTab: (taskId: string, tabId: string) => void
    setActiveBrowserTab: (taskId: string, tabId: string | null) => void
    closeDevTools: (webviewId: number) => unknown
    isDevToolsOpened: (webviewId: number) => unknown
    disableDeviceEmulation: (webviewId: number) => unknown
    registerShortcuts: (webviewId: number) => unknown
    setKeyboardPassthrough: (webviewId: number, enabled: boolean) => unknown
    setDesktopHandoffPolicy: (webviewId: number, policy: unknown) => unknown
    openDevToolsBottom: (webviewId: number, options?: { probe?: boolean }) => unknown
    openDevToolsDetached: (webviewId: number) => unknown
    enableDeviceEmulation: (
      webviewId: number,
      params: {
        screenSize: { width: number; height: number }
        viewSize: { width: number; height: number }
        deviceScaleFactor: number
        screenPosition: 'mobile' | 'desktop'
        userAgent?: string
      }
    ) => unknown
    events: EventEmitter & {
      on(
        event: 'shortcut',
        listener: (payload: { webviewId: number; key: string; shift: boolean }) => void
      ): EventEmitter
      off(event: string, listener: (...args: unknown[]) => void): EventEmitter
    }
  }

  // Task windows + panel ownership. Window-scoped ops take the caller's window
  // id (tRPC: ctx.windowId; IPC: event.sender.id). Same impls back the
  // `task-window:*` / `panels:*` IPC handlers (coexistence until slice 5).
  taskWindows: {
    open: (taskId: string) => unknown
    close: (taskId: string) => unknown
    list: () => unknown
    setPrimaryActive: (taskId: string | null, callerWindowId: number | null) => unknown
    getPrimaryActive: () => unknown
    claimPanel: (taskId: string, panelId: string, ownerWindowId: number) => unknown
    releasePanel: (taskId: string, panelId: string, callerWindowId: number) => unknown
    releaseAllForTask: (taskId: string, callerWindowId: number) => unknown
    getOwnership: (taskId: string) => unknown
    getWindowId: (callerWindowId: number) => unknown
    claimAndCloseOther: (taskId: string, panelId: string, ownerWindowId: number) => unknown
    claimSession: (sessionId: string, callerWindowId: number) => unknown
    events: EventEmitter & {
      on(event: 'list-changed', listener: (taskIds: string[]) => void): EventEmitter
      on(event: 'primary-active-changed', listener: (taskId: string | null) => void): EventEmitter
      on(
        event: 'ownership-changed',
        listener: (payload: {
          taskId: string
          ownership: Array<{ panelId: string; ownerWindowId: number }>
        }) => void
      ): EventEmitter
      on(
        event: 'panels-released-on-close',
        listener: (payload: {
          closedWindowId: number
          released: Array<{ taskId: string; panelId: string }>
        }) => void
      ): EventEmitter
      on(
        event: 'panels-close-request',
        listener: (targetWindowId: number, payload: { taskId: string; panelId: string }) => void
      ): EventEmitter
      off(event: string, listener: (...args: unknown[]) => void): EventEmitter
    }
  }
}

let appDeps: AppDeps | null = null

export function setAppDeps(deps: AppDeps): void {
  appDeps = deps
}

export function getAppDeps(): AppDeps {
  if (!appDeps) throw new Error('appDeps not initialized — call setAppDeps() in main host first')
  return appDeps
}

// Processes deps — the long-running child-process manager. Lifecycle ops plus the
// live `processEvents` TypedEmitter the 4 streaming subscriptions wrap. Lives in
// apps/app/main (electron + child_process), injected via setProcessesDeps(); the
// same emitter also drives the legacy `win.webContents.send` IPC (dual-emit,
// coexistence until slice 5).
export type ProcessesDeps = {
  create: (
    projectId: string | null,
    taskId: string | null,
    label: string,
    command: string,
    cwd: string,
    autoRestart: boolean
  ) => string | Promise<string>
  spawn: (
    projectId: string | null,
    taskId: string | null,
    label: string,
    command: string,
    cwd: string,
    autoRestart: boolean
  ) => string | Promise<string>
  update: (
    processId: string,
    updates: Partial<
      Pick<ProcessInfo, 'label' | 'command' | 'cwd' | 'autoRestart' | 'taskId' | 'projectId'>
    >
  ) => boolean
  stop: (processId: string) => boolean | Promise<boolean>
  kill: (processId: string) => boolean | Promise<boolean>
  restart: (processId: string) => boolean | Promise<boolean>
  listForTask: (taskId: string | null, projectId: string | null) => ProcessInfo[]
  listAll: () => ProcessInfo[]
  killTask: (taskId: string) => void
  events: TypedEmitter<ProcessEventMap>
}

let processesDeps: ProcessesDeps | null = null

export function setProcessesDeps(deps: ProcessesDeps): void {
  processesDeps = deps
}

export function getProcessesDeps(): ProcessesDeps {
  if (!processesDeps)
    throw new Error('processesDeps not initialized — call setProcessesDeps() in main host first')
  return processesDeps
}
