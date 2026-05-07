import type { ExecutionContext } from '@slayzone/projects/shared'
import type { DesktopHandoffPolicy } from '@slayzone/task/shared'
import type {
  TerminalMode,
  TerminalState,
  PtyInfo,
  SessionInfo,
  PromptInfo,
  BufferSinceResult,
  ValidationResult,
  TerminalModeInfo,
  CreateTerminalModeInput,
  UpdateTerminalModeInput,
} from '@slayzone/terminal/shared'

export interface ChatSessionInfo {
  sessionId: string
  tabId: string
  mode: string
  cwd: string
  pid: number | null
  startedAt: string
  ended: boolean
  /**
   * Resolved chat permission mode this session was spawned with. In-memory
   * truth from the running subprocess — fresher than the DB cache because
   * it's set synchronously at spawn time. Renderer prefers this over
   * `chat:getMode` (DB) on mount when a session exists. Optional because
   * non-claude adapters don't track a permission mode.
   */
  chatMode?: 'plan' | 'auto-accept' | 'auto' | 'bypass' | null
  /** Resolved chat model alias this session was spawned with. */
  chatModel?: 'sonnet' | 'opus' | 'haiku' | null
  /** Resolved reasoning effort this session was spawned with. `null` = inherit. */
  chatEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
}
export type { ExecutionContext } from '@slayzone/projects/shared'

export type BrowserCreateTaskFromLinkSource = 'modified-link-click' | 'link-context-menu'

export interface BrowserCreateTaskFromLinkIntent {
  viewId: string
  taskId: string
  url: string
  linkText?: string
  source: BrowserCreateTaskFromLinkSource
}

export interface BackupInfo {
  filename: string
  name: string
  timestamp: string
  type: 'auto' | 'manual' | 'migration'
  sizeBytes: number
}

export interface BackupSettings {
  autoEnabled: boolean
  intervalMinutes: number
  maxAutoBackups: number
  nextBackupNumber: number
}

export interface LocalLeaderboardDay {
  date: string
  totalTokens: number
  totalCompletedTasks: number
}

export interface LocalLeaderboardStats {
  days: LocalLeaderboardDay[]
}

export type ProcessStatus = 'running' | 'stopped' | 'completed' | 'error'

export interface ProcessStats {
  cpu: number   // % of one core
  rss: number   // kilobytes
}

export interface ProcessInfo {
  id: string
  taskId: string | null
  projectId: string | null
  label: string
  command: string
  cwd: string
  autoRestart: boolean
  status: ProcessStatus
  pid: number | null
  exitCode: number | null
  logBuffer: string[]
  startedAt: string
  restartCount: number
  spawnedAt: string | null
  processTitle: string | null
}

export type UpdateStatus =
  | { type: 'checking' }
  | { type: 'downloading'; percent: number }
  | { type: 'downloaded'; version: string }
  | { type: 'not-available' }
  | { type: 'error'; message: string }

export interface PtyCreateOptions {
  sessionId: string
  cwd: string
  conversationId?: string | null
  existingConversationId?: string | null
  mode?: TerminalMode
  initialPrompt?: string | null
  providerFlags?: string | null
  executionContext?: ExecutionContext | null
  cols?: number
  rows?: number
}

// ElectronAPI interface - the IPC contract between renderer and main
export interface ElectronAPI {
  shortcuts: {
    changed: () => void
  }
  dialog: {
    showOpenDialog: (options: {
      title?: string
      defaultPath?: string
      properties?: Array<'openFile' | 'openDirectory' | 'multiSelections' | 'showHiddenFiles' | 'createDirectory' | 'promptToCreate' | 'noResolveAliases' | 'treatPackageAsDirectory' | 'dontAddToRecent'>
      filters?: Array<{ name: string; extensions: string[] }>
    }) => Promise<{ canceled: boolean; filePaths: string[] }>
  }
  app: {
    getTrpcPort: () => Promise<number>
    isTestsPanelEnabledSync: boolean
    isJiraIntegrationEnabledSync: boolean
    isLoopModeEnabledSync: boolean
    isPlaywright: boolean
    onGoHome: (callback: () => void) => () => void
    onToggleAgentPanel: (callback: () => void) => () => void
    onToggleAgentStatusPanel: (callback: () => void) => () => void
    onOpenSettings: (callback: () => void) => () => void
    onOpenProjectSettings: (callback: () => void) => () => void
    onNewTemporaryTask: (callback: () => void) => () => void
    onTasksChanged: (callback: () => void) => () => void
    onSettingsChanged: (callback: () => void) => () => void
    onCloseTask: (callback: (taskId: string) => void) => () => void
    onBrowserEnsurePanelOpen: (callback: (taskId: string, url?: string, tabId?: string) => void) => () => void
    onBrowserCreateTab: (callback: (payload: { taskId: string; tabId: string; url?: string; background?: boolean }) => void) => () => void
    onOpenTask: (callback: (taskId: string) => void) => () => void
    onOpenArtifact: (callback: (taskId: string, artifactId: string) => void) => () => void
    onScreenshotTrigger: (callback: () => void) => () => void
    onUpdateStatus: (callback: (status: UpdateStatus) => void) => () => void
    onCloseCurrent: (callback: () => void) => () => void
    onSyncSessionId: (callback: () => void) => () => void
    onReloadBrowser: (callback: () => void) => () => void
    onReloadApp: (callback: () => void) => () => void
    onZoomFactorChanged: (callback: (factor: number) => void) => () => void
    onCloseActiveTask: (callback: () => void) => () => void
    dataReady: () => void
    bootMark: (label: string) => void
  }
  taskWindow: {
    open: (taskId: string) => Promise<{ ok: boolean; focused?: boolean }>
    close: (taskId: string) => Promise<{ ok: boolean; closed: number }>
    list: () => Promise<string[]>
    onListChanged: (callback: (taskIds: string[]) => void) => () => void
    setPrimaryActive: (taskId: string | null) => Promise<{ ok: boolean }>
    getPrimaryActive: () => Promise<string | null>
    onPrimaryActiveChanged: (callback: (taskId: string | null) => void) => () => void
  }
  panels: {
    claim: (taskId: string, panelId: string) => Promise<{ ok: boolean; unchanged?: boolean }>
    claimAndCloseOther: (taskId: string, panelId: string) => Promise<{ ok: boolean }>
    release: (taskId: string, panelId: string) => Promise<{ ok: boolean; unchanged?: boolean; reason?: string }>
    releaseAllForTask: (taskId: string) => Promise<{ ok: boolean; released: number }>
    getOwnership: (taskId: string) => Promise<Array<{ panelId: string; ownerWindowId: number }>>
    getWindowId: () => Promise<number>
    onOwnershipChanged: (callback: (payload: { taskId: string; ownership: Array<{ panelId: string; ownerWindowId: number }> }) => void) => () => void
    onReleasedOnClose: (callback: (payload: { closedWindowId: number; released: Array<{ taskId: string; panelId: string }> }) => void) => () => void
    onCloseRequest: (callback: (payload: { taskId: string; panelId: string }) => void) => () => void
  }
  window: {
    close: () => Promise<void>
  }
  files: {
    getDropPaths: () => string[]
    getPastePaths: () => string[]
  }
  pty: {
    create: (opts: PtyCreateOptions) => Promise<{ success: boolean; error?: string }>
    testExecutionContext: (context: ExecutionContext) => Promise<{ success: boolean; error?: string }>
    ccsListProfiles: () => Promise<{ profiles: string[]; error?: string }>
    write: (sessionId: string, data: string) => Promise<boolean>
    submit: (sessionId: string, text: string) => Promise<boolean>
    resize: (sessionId: string, cols: number, rows: number) => Promise<boolean>
    kill: (sessionId: string) => Promise<boolean>
    exists: (sessionId: string) => Promise<boolean>
    getBuffer: (sessionId: string) => Promise<string | null>
    clearBuffer: (
      sessionId: string
    ) => Promise<{ success: boolean; clearedSeq: number | null }>
    getBufferSince: (sessionId: string, afterSeq: number) => Promise<BufferSinceResult | null>
    list: () => Promise<PtyInfo[]>
    onData: (callback: (sessionId: string, data: string, seq: number) => void) => () => void
    onExit: (callback: (sessionId: string, exitCode: number) => void) => () => void
    onRespawnSuggested: (callback: (taskId: string) => void) => () => void
    onForceRespawn: (callback: (taskId: string, reqId: number) => void) => () => void
    ackForceRespawn: (reqId: number, ok: boolean) => void
    onSessionNotFound: (callback: (sessionId: string) => void) => () => void
    onStateChange: (
      callback: (sessionId: string, newState: TerminalState, oldState: TerminalState) => void
    ) => () => void
    onPrompt: (callback: (sessionId: string, prompt: PromptInfo) => void) => () => void
    onSessionDetected: (callback: (sessionId: string, conversationId: string) => void) => () => void
    onDevServerDetected: (callback: (sessionId: string, url: string) => void) => () => void
    onTitleChange: (callback: (sessionId: string, title: string) => void) => () => void
    onResizeNeeded: (callback: (sessionId: string) => void) => () => void
    onStats: (cb: (stats: Record<string, ProcessStats>) => void) => () => void
    getState: (sessionId: string) => Promise<TerminalState | null>
    validate: (mode: TerminalMode) => Promise<ValidationResult[]>
    setTheme: (theme: { foreground: string; background: string; cursor: string; ansi?: readonly string[] }) => Promise<void>
    setShellOverride: (value: string | null) => Promise<void>
    claimSession: (sessionId: string) => Promise<{ ok: boolean }>
  }
  session: {
    list: () => Promise<SessionInfo[]>
    getState: (sessionId: string) => Promise<TerminalState | null>
  }
  terminalModes: {
    list: () => Promise<TerminalModeInfo[]>
    get: (id: string) => Promise<TerminalModeInfo | null>
    create: (input: CreateTerminalModeInput) => Promise<TerminalModeInfo>
    update: (id: string, updates: UpdateTerminalModeInput) => Promise<TerminalModeInfo | null>
    delete: (id: string) => Promise<boolean>
    test: (command: string) => Promise<{ ok: boolean; error?: string; detail?: string }>
    restoreDefaults: () => Promise<void>
    resetToDefaultState: () => Promise<void>
  }
  telemetry: {
    onIpcEvent: (callback: (event: string, props: Record<string, unknown>) => void) => () => void
  }
  webview: {
    registerShortcuts: (webviewId: number) => Promise<void>
    setKeyboardPassthrough: (webviewId: number, enabled: boolean) => Promise<void>
    setDesktopHandoffPolicy: (webviewId: number, policy: DesktopHandoffPolicy | null) => Promise<boolean>
    onShortcut: (callback: (payload: { key: string; shift?: boolean; webviewId?: number }) => void) => () => void
    openDevToolsBottom: (webviewId: number) => Promise<boolean>
    openDevToolsDetached: (webviewId: number) => Promise<boolean>
    closeDevTools: (webviewId: number) => Promise<boolean>
    isDevToolsOpened: (webviewId: number) => Promise<boolean>
    enableDeviceEmulation: (
      webviewId: number,
      params: {
        screenSize: { width: number; height: number }
        viewSize: { width: number; height: number }
        deviceScaleFactor: number
        screenPosition: 'mobile' | 'desktop'
        userAgent?: string
      }
    ) => Promise<boolean>
    disableDeviceEmulation: (webviewId: number) => Promise<boolean>
    registerBrowserTab: (taskId: string, tabId: string, webContentsId: number) => Promise<void>
    unregisterBrowserTab: (taskId: string, tabId: string) => Promise<void>
    setActiveBrowserTab: (taskId: string, tabId: string | null) => Promise<void>
  }
  browser: {
    // Subscription-style methods kept as IPC (driven by webContents.send from manager).
    onBrowserViewShortcut: (cb: (payload: {
      viewId: string
      key: string
      shift: boolean
      alt: boolean
      meta: boolean
      control: boolean
      kind?: string
    }) => void) => () => void
    onBrowserViewFocused: (cb: (payload: { viewId: string }) => void) => () => void
    onCreateTaskFromLink: (cb: (intent: BrowserCreateTaskFromLinkIntent) => void) => () => void
    onEvent: (cb: (event: {
      viewId: string
      type: string
      [key: string]: unknown
    }) => void) => () => void
  }
}
