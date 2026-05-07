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
  AgentEvent,
  SkillInfo,
  CommandInfo,
  AgentInfo,
  FileMatch,
  ChatSessionStateEntry,
  QueuedChatMessage,
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
  auth: {
    githubSystemSignIn: (input: { convexUrl: string; redirectTo: string }) => Promise<{
      ok: boolean
      code?: string
      verifier?: string
      error?: string
      cancelled?: boolean
    }>
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
    getProtocolClientStatus: () => Promise<{
      scheme: string
      attempted: boolean
      registered: boolean
      reason: 'registered' | 'dev-skipped' | 'registration-failed'
    }>
    getVersion: () => Promise<string>
    getTrpcPort: () => Promise<number>
    isTestsPanelEnabled: () => Promise<boolean>
    isTestsPanelEnabledSync: boolean
    isJiraIntegrationEnabled: () => Promise<boolean>
    isJiraIntegrationEnabledSync: boolean
    isLoopModeEnabled: () => Promise<boolean>
    isLoopModeEnabledSync: boolean
    getZoomFactor: () => Promise<number>
    adjustZoom: (command: 'in' | 'out' | 'reset') => Promise<number>
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
    restartForUpdate: () => Promise<void>
    checkForUpdates: () => Promise<void>
    cliStatus: () => Promise<{ installed: boolean; path?: string }>
    installCli: () => Promise<{ ok: boolean; path?: string; permissionDenied?: boolean; elevationCancelled?: boolean; error?: string; pathNotInPATH?: boolean }>
  }
  floatingAgent: {
    setEnabled: (enabled: boolean) => Promise<{ kind: string }>
    setSessionId: (sessionId: string | null) => Promise<{ kind: string }>
    setPanelOpen: (isOpen: boolean) => Promise<{ kind: string }>
    toggleCollapse: () => Promise<{ kind: string; collapsed: boolean }>
    resetSize: () => Promise<{ kind: string }>
    detach: () => Promise<{ kind: string; sessionId: string | null; mode: 'auto' | 'manual' | null; hasCustomSize: boolean }>
    reattach: () => Promise<{ kind: string; sessionId: string | null; mode: 'auto' | 'manual' | null; hasCustomSize: boolean }>
    getState: () => Promise<{ kind: string; sessionId: string | null; mode: 'auto' | 'manual' | null; hasCustomSize: boolean }>
    getSession: () => Promise<{ sessionId: string; cwd: string; mode: string } | null>
    getConfig: () => Promise<{ style: string; position: string }>
    onState: (callback: (state: { kind: string; sessionId: string | null; mode: 'auto' | 'manual' | null; hasCustomSize: boolean }) => void) => () => void
    onSessionChanged: (callback: () => void) => () => void
    onCollapseChanged: (callback: (collapsed: boolean) => void) => () => void
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
  chat: {
    supports: (mode: string) => Promise<boolean>
    create: (opts: {
      tabId: string
      taskId: string
      mode: string
      cwd: string
      providerFlagsOverride?: string | null
    }) => Promise<ChatSessionInfo>
    send: (tabId: string, text: string) => Promise<boolean>
    /**
     * Resolve a pending `tool_use_id` with a `tool_result` content block.
     * Used by inline-answer flows like AskUserQuestion so the SDK's turn
     * machinery sees a normal completion. Returns false when the adapter
     * lacks a structured-input channel — caller should fall back to `send`.
     */
    sendToolResult: (
      tabId: string,
      args: { toolUseId: string; content: string; isError?: boolean }
    ) => Promise<boolean>
    /**
     * Reply to an inbound `can_use_tool` control_request (surfaces under
     * `--permission-prompt-tool stdio`). The renderer gathered the user's
     * decision (e.g. AskUserQuestion answers) — this IPC writes the matching
     * control_response so the CLI unblocks the tool.
     */
    respondPermission: (
      tabId: string,
      args: {
        requestId: string
        decision:
          | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }
          | { behavior: 'deny'; message: string; interrupt?: boolean }
      }
    ) => Promise<boolean>
    /**
     * Stop the current turn but keep the session. Implemented as kill + respawn
     * with --resume on the main side: history + chat conversation id survive,
     * the subprocess restarts ready for the next user message.
     */
    interrupt: (opts: {
      tabId: string
      taskId: string
      mode: string
      cwd: string
      providerFlagsOverride?: string | null
    }) => Promise<ChatSessionInfo>
    /**
     * Stop the current turn. If no assistant progress arrived since the last
     * user-message, cancels that user-message instead of leaving an `interrupted`
     * marker — Claude CLI parity. Returns `popped: true` + the cancelled text so
     * the renderer can restore the chat input. When `popped: false`, behaves
     * identically to `interrupt`.
     */
    abortAndPop: (opts: {
      tabId: string
      taskId: string
      mode: string
      cwd: string
      providerFlagsOverride?: string | null
    }) => Promise<{ popped: boolean; text: string | null }>
    kill: (tabId: string) => Promise<void>
    remove: (tabId: string) => Promise<void>
    /**
     * Atomic reset: kills the current session, wipes persisted events + stored
     * conversation id, and spawns a fresh session in one IPC. Replaces the older
     * client-orchestrated kill→remove→create sequence which had a race where a
     * stale exit could leak between awaits.
     */
    reset: (opts: {
      tabId: string
      taskId: string
      mode: string
      cwd: string
      providerFlagsOverride?: string | null
    }) => Promise<ChatSessionInfo>
    getBufferSince: (
      tabId: string,
      afterSeq: number
    ) => Promise<Array<{ seq: number; event: AgentEvent }>>
    getInfo: (tabId: string) => Promise<ChatSessionInfo | null>
    inspectPermissions: (
      taskId: string,
      mode: string
    ) => Promise<{
      ok: boolean
      hasSkipPerms: boolean
      hasPermissionMode: boolean
      permissionModeValue: string | null
    }>
    getMode: (taskId: string, mode: string) => Promise<'plan' | 'auto-accept' | 'auto' | 'bypass'>
    setMode: (opts: {
      tabId: string
      taskId: string
      mode: string
      cwd: string
      chatMode: 'plan' | 'auto-accept' | 'auto' | 'bypass'
    }) => Promise<ChatSessionInfo>
    getModel: (taskId: string, mode: string) => Promise<'sonnet' | 'opus' | 'haiku'>
    setModel: (opts: {
      tabId: string
      taskId: string
      mode: string
      cwd: string
      chatModel: 'sonnet' | 'opus' | 'haiku'
    }) => Promise<ChatSessionInfo>
    getEffort: (taskId: string, mode: string) => Promise<'low' | 'medium' | 'high' | 'xhigh' | 'max' | null>
    setEffort: (opts: {
      tabId: string
      taskId: string
      mode: string
      cwd: string
      chatEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    }) => Promise<ChatSessionInfo>
    /**
     * Detect whether `--permission-mode auto` is usable. Reads `~/.claude.json` +
     * `~/.claude/settings.json` to determine plan eligibility (Max/Team/Enterprise)
     * and one-time opt-in status. UI hides the option when not eligible and
     * disables it when eligible-but-not-opted-in.
     */
    getAutoEligibility: () => Promise<{ eligible: boolean; optedIn: boolean }>
    list: () => Promise<ChatSessionStateEntry[]>
    listSkills: (cwd: string) => Promise<SkillInfo[]>
    listCommands: (cwd: string) => Promise<CommandInfo[]>
    listAgents: (cwd: string) => Promise<AgentInfo[]>
    listFiles: (cwd: string, query: string, limit?: number) => Promise<FileMatch[]>
    /**
     * Per-(source,name) usage map for chat autocomplete tiebreak ranking.
     * Bumped on successful chat send for each /token resolved to a known item.
     * Shape: `{ [sourceId]: { [name]: count } }`.
     */
    getAutocompleteUsage: () => Promise<Record<string, Record<string, number>>>
    bumpAutocompleteUsage: (source: string, name: string) => Promise<void>
    onEvent: (callback: (tabId: string, event: AgentEvent, seq: number) => void) => () => void
    onExit: (
      callback: (
        tabId: string,
        sessionId: string,
        code: number | null,
        signal: string | null
      ) => void
    ) => () => void
  }
  /**
   * Backend-persisted "Up next" chat queue. Source-of-truth lives in SQLite
   * so queued messages survive reload/crash and stay sync'd across windows.
   * Drained main-side on session→idle transitions; renderer is purely a
   * subscriber + dispatcher.
   */
  chatQueue: {
    list: (tabId: string) => Promise<QueuedChatMessage[]>
    /**
     * Append to tail. `send` is the post-`transformSubmit` text that goes
     * over the wire; `original` is the raw composer input retained so the
     * autocomplete usage hook can bump tiebreak counts on drain.
     */
    push: (tabId: string, send: string, original: string) => Promise<QueuedChatMessage>
    remove: (id: string) => Promise<boolean>
    clear: (tabId: string) => Promise<number>
    /** Fires after any list mutation (push/remove/clear/drain). Renderer refetches. */
    onChanged: (callback: (tabId: string) => void) => () => void
    /**
     * Fires after the drainer pops + dispatches. Carries the `original` text
     * so renderer can call its usage-bump hook with the raw `/cmd` token.
     */
    onDrained: (callback: (tabId: string, original: string) => void) => () => void
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
    // Lifecycle
    createView: (opts: {
      taskId: string
      tabId: string
      partition?: string
      url: string
      bounds: { x: number; y: number; width: number; height: number }
      kind?: 'browser-tab' | 'web-panel'
      desktopHandoffPolicy?: DesktopHandoffPolicy | null
    }) => Promise<string>
    destroyView: (viewId: string) => Promise<void>
    destroyAllForTask: (taskId: string) => Promise<void>
    reparentToCurrentWindow: (viewId: string) => Promise<{ ok: boolean }>
    listViews: () => Promise<Array<{
      viewId: string
      taskId: string
      tabId: string
      kind: 'browser-tab' | 'web-panel'
      visible: boolean
      nativelyAttached: boolean
      currentWindowId: number | null
      url: string
      partition: string
    }>>

    // Bounds & visibility
    setBounds: (viewId: string, bounds: { x: number; y: number; width: number; height: number }) => Promise<void>
    setVisible: (viewId: string, visible: boolean) => Promise<void>
    hideAll: () => Promise<void>
    showAll: () => Promise<void>
    setHandoffPolicy: (viewId: string, policy: DesktopHandoffPolicy | null) => Promise<void>

    // Navigation
    navigate: (viewId: string, url: string) => Promise<void>
    goBack: (viewId: string) => Promise<void>
    goForward: (viewId: string) => Promise<void>
    reload: (viewId: string, ignoreCache?: boolean) => Promise<void>
    stop: (viewId: string) => Promise<void>

    // Content
    executeJs: (viewId: string, code: string) => Promise<unknown>
    insertCss: (viewId: string, css: string) => Promise<string>
    removeCss: (viewId: string, key: string) => Promise<void>
    setZoom: (viewId: string, factor: number) => Promise<void>
    focus: (viewId: string) => Promise<void>
    findInPage: (viewId: string, text: string, options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }) => Promise<number | null>
    stopFindInPage: (viewId: string, action: 'clearSelection' | 'keepSelection' | 'activateSelection') => Promise<void>
    getWebContentsId: (viewId: string) => Promise<number | null>
    setKeyboardPassthrough: (viewId: string, enabled: boolean) => Promise<void>
    sendInputEvent: (viewId: string, input: { type: 'keyDown' | 'keyUp' | 'char'; keyCode: string; modifiers?: string[] }) => Promise<void>

    // Events (M→R)
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

    // DevTools
    openDevTools: (viewId: string, mode: 'bottom' | 'right' | 'undocked' | 'detach') => Promise<void>
    closeDevTools: (viewId: string) => Promise<void>
    isDevToolsOpen: (viewId: string) => Promise<boolean>

    // Chrome extensions (R→M)
    getExtensions: () => Promise<{ id: string; name: string; version?: string; icon?: string; manifestVersion?: number }[]>
    loadExtension: () => Promise<{ id: string; name: string } | { error: string } | null>
    removeExtension: (extensionId: string) => Promise<void>
    discoverBrowserExtensions: () => Promise<{
      name: string
      extensions: { id: string; name: string; version: string; path: string; alreadyImported: boolean; manifestVersion?: number }[]
    }[]>
    importExtension: (path: string) => Promise<{ id: string; name: string } | { error: string }>
    activateExtension: (extensionId: string) => Promise<boolean>
    onCreateTaskFromLink: (cb: (intent: BrowserCreateTaskFromLinkIntent) => void) => () => void

    // Events (M→R)
    onEvent: (cb: (event: {
      viewId: string
      type: string
      [key: string]: unknown
    }) => void) => () => void
  }
  processes: {
    create: (projectId: string | null, taskId: string | null, label: string, command: string, cwd: string, autoRestart: boolean) => Promise<string>
    spawn: (projectId: string | null, taskId: string | null, label: string, command: string, cwd: string, autoRestart: boolean) => Promise<string>
    update: (processId: string, updates: Partial<Pick<ProcessInfo, 'label' | 'command' | 'cwd' | 'autoRestart' | 'taskId' | 'projectId'>>) => Promise<boolean>
    stop: (processId: string) => Promise<boolean>
    kill: (processId: string) => Promise<boolean>
    restart: (processId: string) => Promise<boolean>
    listForTask: (taskId: string | null, projectId: string | null) => Promise<ProcessInfo[]>
    listAll: () => Promise<ProcessInfo[]>
    killTask: (taskId: string) => Promise<void>
    onLog: (cb: (processId: string, line: string) => void) => () => void
    onStatus: (cb: (processId: string, status: ProcessStatus) => void) => () => void
    onStats: (cb: (stats: Record<string, ProcessStats>) => void) => () => void
    onTitle: (cb: (processId: string, title: string | null) => void) => () => void
  }
}
