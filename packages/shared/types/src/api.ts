import type { ExecutionContext } from '@slayzone/projects/shared'
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
  app: {
    getTrpcPort: () => Promise<number>
    isTestsPanelEnabledSync: boolean
    isJiraIntegrationEnabledSync: boolean
    isLoopModeEnabledSync: boolean
    isPlaywright: boolean
    windowId: number
    dataReady: () => void
    bootMark: (label: string) => void
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
