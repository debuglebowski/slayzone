import type { Project, CreateProjectInput, UpdateProjectInput, ExecutionContext } from '@slayzone/projects/shared'
import type { Task, CreateTaskInput, UpdateTaskInput, DesktopHandoffPolicy, TaskTemplate, CreateTaskTemplateInput, UpdateTaskTemplateInput, TaskArtifact, CreateArtifactInput, UpdateArtifactInput, ArtifactFolder, CreateArtifactFolderInput, UpdateArtifactFolderInput } from '@slayzone/task/shared'
import type { ArtifactVersion, VersionRef, DiffResult, PruneReport } from '@slayzone/task-artifacts/shared'
import type { Tag } from '@slayzone/tags/shared'
import type { AgentTurnRange } from '@slayzone/agent-turns/shared'
import type {
  TerminalMode,
  TerminalState,
  PtyInfo,
  SessionInfo,
  PromptInfo,
  BufferSinceResult,
  ProviderUsage,
  UsageWindow,
  UsageProviderConfig,
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
import type { TerminalTab, CreateTerminalTabInput, UpdateTerminalTabInput } from '@slayzone/task-terminals/shared'
import type { Theme, ThemePreference } from '@slayzone/settings/shared'
import type { CreateWorktreeOpts, CreateWorktreeResult, CreateWorktreePhase, IgnoredFileNode, DetectedWorktree, MergeResult, MergeWithAIResult, GitDiffSnapshot, GitSyncResult, ConflictFileContent, ConflictAnalysis, RebaseProgress, CommitInfo, AheadBehind, StatusSummary, BranchListResult, DeleteBranchResult, PruneResult, DiffStatsSummary, WorktreeMetadata, RebaseOntoResult, DagCommit, ResolvedGraph, ForkGraphResult, GhPullRequest, GhPrTimelineEvent, CreatePrInput, CreatePrResult, MergePrInput, EditPrCommentInput, StashEntry, StashApplyResult, RepoEntry, ListProjectReposOpts } from '@slayzone/worktrees/shared'
import type { MergeContext } from '@slayzone/task/shared'
import type {
  AiConfigItem,
  AiConfigProjectSelection,
  CliProvider,
  CliProviderInfo,
  ContextFileInfo,
  ContextTreeEntry,
  CreateAiConfigItemInput,
  ListAiConfigItemsInput,
  LoadLibraryItemInput,
  McpConfigFileResult,
  ProjectSkillStatus,
  ProviderFileContent,
  RootInstructionsResult,
  SetAiConfigProjectSelectionInput,
  SyncAllInput,
  SyncConflict,
  SyncResult,
  UpdateAiConfigItemInput,
  WriteMcpServerInput,
  RemoveMcpServerInput,
  WriteComputerMcpServerInput,
  RemoveComputerMcpServerInput,
  ComputerFileEntry,
  SkillRegistry,
  SkillRegistryEntry,
  AddRegistryInput,
  InstallSkillInput,
  ListEntriesInput,
  SkillUpdateInfo
} from '@slayzone/ai-config/shared'
import type { DirEntry, ReadFileResult, FileSearchResult, SearchFilesOptions, GitStatusMap } from '@slayzone/file-editor/shared'
import type { TestCategory, CreateTestCategoryInput, UpdateTestCategoryInput, TestProfile, ScanResult, TestLabel, CreateTestLabelInput, UpdateTestLabelInput, TestFileLabel, TestFileNote } from '@slayzone/test-panel/shared'
import type { Automation, AutomationRun, CreateAutomationInput, UpdateAutomationInput } from '@slayzone/automations/shared'
import type { AutomationActionRun, ListTaskHistoryOptions, ListTaskHistoryResult } from '@slayzone/history/shared'
import type {
  ConnectGithubInput,
  ConnectLinearInput,
  UpdateIntegrationConnectionInput,
  ClearProjectProviderInput,
  ClearProjectConnectionInput,
  ExternalLink,
  GithubIssueSummary,
  GithubProjectSummary,
  GithubRepositorySummary,
  ImportGithubRepositoryIssuesInput,
  ImportGithubRepositoryIssuesResult,
  ImportGithubIssuesInput,
  ImportGithubIssuesResult,
  ImportLinearIssuesInput,
  ImportLinearIssuesResult,
  IntegrationConnectionPublic,
  IntegrationConnectionUsage,
  IntegrationProjectMapping,
  IntegrationProvider,
  ListGithubRepositoryIssuesInput,
  ListGithubIssuesInput,
  ListLinearIssuesInput,
  LinearIssueSummary,
  LinearProject,
  LinearTeam,
  PullTaskInput,
  PullTaskResult,
  PushTaskInput,
  PushTaskResult,
  SetProjectMappingInput,
  SetProjectConnectionInput,
  SyncNowInput,
  SyncNowResult,
  TaskSyncStatus,
  FetchProviderStatusesInput,
  ApplyStatusSyncInput,
  ProviderStatus,
  StatusResyncPreview,
  PushUnlinkedTasksInput,
  PushUnlinkedTasksResult,
  BatchTaskSyncStatusItem,
  ListProviderIssuesInput,
  ImportProviderIssuesInput,
  ImportProviderIssuesResult,
  NormalizedIssue,
  ExternalGroup,
  ExternalScope,
  ConnectJiraInput,
  JiraTransition
} from '@slayzone/integrations/shared'

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

export interface DiagnosticsConfig {
  enabled: boolean
  verbose: boolean
  includePtyOutput: boolean
  retentionDays: number
}

export interface DiagnosticsExportRequest {
  fromTsMs: number
  toTsMs: number
}

export interface DiagnosticsExportResult {
  success: boolean
  canceled?: boolean
  path?: string
  eventCount?: number
  error?: string
}

export interface ClientErrorEventInput {
  type: 'window.error' | 'window.unhandledrejection' | 'error-boundary'
  message: string
  stack?: string | null
  componentStack?: string | null
  url?: string | null
  line?: number | null
  column?: number | null
  snapshot?: Record<string, unknown> | null
}

export interface ClientDiagnosticEventInput {
  event: string
  level?: 'debug' | 'info' | 'warn' | 'error'
  message?: string | null
  traceId?: string | null
  taskId?: string | null
  projectId?: string | null
  sessionId?: string | null
  channel?: string | null
  payload?: unknown
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
  db: {
    // Projects
    getProjects: () => Promise<Project[]>
    createProject: (data: CreateProjectInput) => Promise<Project>
    updateProject: (data: UpdateProjectInput) => Promise<Project>
    deleteProject: (id: string) => Promise<boolean>
    reorderProjects: (projectIds: string[]) => Promise<void>
    uploadProjectIcon: (projectId: string, sourcePath: string) => Promise<Project>

    // Tasks
    getTasks: () => Promise<Task[]>
    loadBoardData: () => Promise<{
      tasks: Task[]
      projects: Project[]
      tags: Tag[]
      taskTags: Record<string, string[]>
      blockedTaskIds: string[]
    }>
    getTasksByProject: (projectId: string) => Promise<Task[]>
    getTask: (id: string) => Promise<Task | null>
    getSubTasks: (parentId: string) => Promise<Task[]>
    getSubTasksRecursive: (rootId: string) => Promise<Task[]>
    createTask: (data: CreateTaskInput) => Promise<Task>
    updateTask: (data: UpdateTaskInput) => Promise<Task>
    updateTasks: (data: { ids: string[]; updates: Omit<Partial<UpdateTaskInput>, 'id'> }) => Promise<Task[]>
    deleteTask: (id: string) => Promise<boolean>
    deleteTasks: (ids: string[]) => Promise<{ deletedIds: string[]; blockedIds: string[] }>
    restoreTask: (id: string) => Promise<Task>
    archiveTask: (id: string) => Promise<Task>
    archiveTasks: (ids: string[]) => Promise<void>
    unarchiveTask: (id: string) => Promise<Task>
    reorderTasks: (taskIds: string[]) => Promise<void>
  }
  agentTurns: {
    list: (worktreePath: string) => Promise<AgentTurnRange[]>
    onChanged: (callback: (worktreePath: string) => void) => () => void
  }
  artifacts: {
    getByTask: (taskId: string) => Promise<TaskArtifact[]>
    get: (id: string) => Promise<TaskArtifact | null>
    create: (data: CreateArtifactInput) => Promise<TaskArtifact>
    update: (data: UpdateArtifactInput & { mutateVersion?: boolean }) => Promise<TaskArtifact | null>
    delete: (id: string) => Promise<boolean>
    reorder: (data: string[] | { folderId: string | null; artifactIds: string[] }) => Promise<void>
    readContent: (id: string) => Promise<string | null>
    getFilePath: (id: string) => Promise<string | null>
    getMtime: (id: string) => Promise<number | null>
    onContentChanged: (callback: (artifactId: string) => void) => () => void
    upload: (data: { taskId: string; sourcePath: string; title?: string }) => Promise<TaskArtifact>
    uploadBlob: (data: { taskId: string; title: string; bytes: Uint8Array; folderId?: string | null }) => Promise<TaskArtifact | null>
    pasteFiles: (data: { sourcePaths: string[]; destTaskId: string; destFolderId: string | null }) => Promise<TaskArtifact[]>
    cleanupTask: (taskId: string) => Promise<void>
    uploadDir: (data: { taskId: string; dirPath: string; parentFolderId: string | null }) => Promise<{ folders: ArtifactFolder[]; artifacts: TaskArtifact[] }>
    downloadFile: (id: string) => Promise<boolean>
    downloadFolder: (id: string) => Promise<boolean>
    downloadAsPdf: (id: string) => Promise<boolean>
    downloadAsPng: (id: string) => Promise<boolean>
    downloadAsHtml: (id: string) => Promise<boolean>
    downloadAllAsZip: (taskId: string) => Promise<boolean>
    versions: {
      list: (data: { artifactId: string; limit?: number; offset?: number }) => Promise<ArtifactVersion[]>
      read: (data: { artifactId: string; versionRef: VersionRef }) => Promise<string>
      create: (data: { artifactId: string; name?: string | null }) => Promise<ArtifactVersion>
      rename: (data: { artifactId: string; versionRef: VersionRef; newName: string | null }) => Promise<ArtifactVersion>
      diff: (data: { artifactId: string; a: VersionRef; b?: VersionRef }) => Promise<DiffResult>
      prune: (data: { artifactId: string; keepLast?: number; keepNamed?: boolean; keepCurrent?: boolean; dryRun?: boolean }) => Promise<PruneReport>
      setCurrent: (data: { artifactId: string; versionRef: VersionRef }) => Promise<ArtifactVersion>
    }
  }
  artifactFolders: {
    getByTask: (taskId: string) => Promise<ArtifactFolder[]>
    create: (data: CreateArtifactFolderInput) => Promise<ArtifactFolder>
    update: (data: UpdateArtifactFolderInput) => Promise<ArtifactFolder | null>
    delete: (id: string) => Promise<boolean>
    reorder: (data: { parentId: string | null; folderIds: string[] }) => Promise<void>
  }
  taskTemplates: {
    getByProject: (projectId: string) => Promise<TaskTemplate[]>
    get: (id: string) => Promise<TaskTemplate | null>
    create: (data: CreateTaskTemplateInput) => Promise<TaskTemplate>
    update: (data: UpdateTaskTemplateInput) => Promise<TaskTemplate | null>
    delete: (id: string) => Promise<boolean>
    setDefault: (projectId: string, templateId: string | null) => Promise<void>
  }
  taskDependencies: {
    getAllBlockedTaskIds: () => Promise<string[]>
    getBlockers: (taskId: string) => Promise<Task[]>
    getBlocking: (taskId: string) => Promise<Task[]>
    addBlocker: (taskId: string, blockerTaskId: string) => Promise<void>
    removeBlocker: (taskId: string, blockerTaskId: string) => Promise<void>
    setBlockers: (taskId: string, blockerTaskIds: string[]) => Promise<void>
  }
  history: {
    listForTask: (taskId: string, options?: ListTaskHistoryOptions) => Promise<ListTaskHistoryResult>
    getAutomationActionRuns: (runId: string) => Promise<AutomationActionRun[]>
  }
  feedback: {
    listThreads: () => Promise<Array<{ id: string; title: string; discord_thread_id: string | null; created_at: string }>>
    createThread: (input: { id: string; title: string; discord_thread_id: string | null }) => Promise<void>
    getMessages: (threadId: string) => Promise<Array<{ id: string; thread_id: string; content: string; created_at: string }>>
    addMessage: (input: { id: string; thread_id: string; content: string }) => Promise<void>
    updateThreadDiscordId: (threadId: string, discordThreadId: string) => Promise<void>
    deleteThread: (threadId: string) => Promise<void>
  }
  settings: {
    get: (key: string) => Promise<string | null>
    set: (key: string, value: string) => Promise<void>
    getAll: () => Promise<Record<string, string>>
  }
  shortcuts: {
    changed: () => void
  }
  theme: {
    getEffective: () => Promise<Theme>
    getSource: () => Promise<ThemePreference>
    set: (theme: ThemePreference) => Promise<Theme>
    onChange: (callback: (theme: Theme) => void) => () => void
  }
  shell: {
    openExternal: (
      url: string,
      options?: {
        // Legacy compatibility. Prefer desktopHandoff.
        blockDesktopHandoff?: boolean
        desktopHandoff?: DesktopHandoffPolicy
      }
    ) => Promise<void>
    openPath: (absPath: string) => Promise<string>
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
    saveTempImage: (
      base64: string,
      mimeType: string
    ) => Promise<{ success: boolean; path?: string; error?: string }>
    pathExists: (path: string) => Promise<boolean>
    getDropPaths: () => string[]
    getPastePaths: () => string[]
  }
  clipboard: {
    writeFilePaths: (paths: string[]) => Promise<void>
    readFilePaths: () => Promise<string[]>
    hasFiles: () => Promise<boolean>
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
  git: {
    isGitRepo: (path: string) => Promise<boolean>
    detectChildRepos: (projectPath: string) => Promise<{ name: string; path: string }[]>
    listProjectRepos: (projectPath: string, opts?: ListProjectReposOpts) => Promise<RepoEntry[]>
    detectWorktrees: (repoPath: string) => Promise<DetectedWorktree[]>
    createWorktree: (opts: CreateWorktreeOpts) => Promise<CreateWorktreeResult>
    onCreateWorktreePhase: (requestId: string, cb: (phase: CreateWorktreePhase) => void) => () => void
    removeWorktree: (repoPath: string, worktreePath: string, branchToDelete?: string) => Promise<{ branchDeleted?: boolean; branchError?: string }>
    init: (path: string) => Promise<void>
    getCurrentBranch: (path: string) => Promise<string | null>
    listBranches: (path: string) => Promise<string[]>
    checkoutBranch: (path: string, branch: string) => Promise<void>
    createBranch: (path: string, branch: string) => Promise<void>
    hasUncommittedChanges: (path: string) => Promise<boolean>
    mergeIntoParent: (projectPath: string, parentBranch: string, sourceBranch: string) => Promise<MergeResult>
    abortMerge: (path: string) => Promise<void>
    mergeWithAI: (projectPath: string, worktreePath: string, parentBranch: string, sourceBranch: string) => Promise<MergeWithAIResult>
    isMergeInProgress: (path: string) => Promise<boolean>
    getConflictedFiles: (path: string) => Promise<string[]>
    getWorkingDiff: (path: string, opts?: { contextLines?: string; ignoreWhitespace?: boolean; fromSha?: string; toSha?: string }) => Promise<GitDiffSnapshot>
    stageFile: (path: string, filePath: string) => Promise<void>
    unstageFile: (path: string, filePath: string) => Promise<void>
    discardFile: (path: string, filePath: string, untracked?: boolean) => Promise<void>
    stageAll: (path: string) => Promise<void>
    unstageAll: (path: string) => Promise<void>
    getFileDiff: (repoPath: string, filePath: string, staged: boolean, opts?: { contextLines?: string; ignoreWhitespace?: boolean }) => Promise<string>
    getUntrackedFileDiff: (repoPath: string, filePath: string) => Promise<string>
    getConflictContent: (repoPath: string, filePath: string) => Promise<ConflictFileContent>
    writeResolvedFile: (repoPath: string, filePath: string, content: string) => Promise<void>
    commitFiles: (repoPath: string, message: string) => Promise<void>
    analyzeConflict: (mode: string, filePath: string, base: string | null, ours: string | null, theirs: string | null) => Promise<ConflictAnalysis>
    isRebaseInProgress: (path: string) => Promise<boolean>
    getRebaseProgress: (repoPath: string) => Promise<RebaseProgress | null>
    abortRebase: (path: string) => Promise<void>
    continueRebase: (path: string) => Promise<{ done: boolean; conflictedFiles: string[] }>
    skipRebaseCommit: (path: string) => Promise<{ done: boolean; conflictedFiles: string[] }>
    getMergeContext: (repoPath: string) => Promise<MergeContext | null>
    getRecentCommits: (repoPath: string, count?: number) => Promise<CommitInfo[]>
    getAheadBehind: (repoPath: string, branch: string, upstream: string) => Promise<AheadBehind>
    getStatusSummary: (repoPath: string) => Promise<StatusSummary>
    revealInFinder: (path: string) => Promise<void>
    isDirty: (path: string) => Promise<boolean>
    getRemoteUrl: (path: string) => Promise<string | null>
    getAheadBehindUpstream: (path: string, branch: string) => Promise<AheadBehind | null>
    fetch: (path: string) => Promise<void>
    push: (path: string, branch?: string, force?: boolean) => Promise<GitSyncResult>
    pull: (path: string) => Promise<GitSyncResult>
    // Branch tab
    getDefaultBranch: (path: string) => Promise<string>
    listBranchesDetailed: (path: string) => Promise<BranchListResult>
    listRemoteBranches: (path: string) => Promise<string[]>
    getMergeBase: (path: string, branch1: string, branch2: string) => Promise<string | null>
    getCommitsSince: (path: string, sinceRef: string, branch: string) => Promise<CommitInfo[]>
    getCommitsBeforeRef: (path: string, ref: string, count?: number) => Promise<CommitInfo[]>
    deleteBranch: (path: string, branch: string, force?: boolean) => Promise<DeleteBranchResult>
    pruneRemote: (path: string) => Promise<PruneResult>
    // Worktree tab
    rebaseOnto: (path: string, ontoBranch: string) => Promise<RebaseOntoResult>
    mergeFrom: (path: string, branch: string) => Promise<MergeResult>
    getDiffStats: (path: string, ref: string) => Promise<DiffStatsSummary>
    getWorktreeMetadata: (path: string) => Promise<WorktreeMetadata>
    // DAG graph
    getCommitDag: (path: string, limit: number, branches?: string[]) => Promise<DagCommit[]>
    getResolvedCommitDag: (path: string, limit: number, branches: string[] | undefined, baseBranch: string) => Promise<ResolvedGraph>
    getResolvedForkGraph: (targetPath: string, repoPath: string, activeBranch: string, compareBranch: string, activeBranchLabel: string, compareBranchLabel: string) => Promise<ForkGraphResult | null>
    getResolvedUpstreamGraph: (repoPath: string, branch: string) => Promise<ForkGraphResult | null>
    getResolvedRecentCommits: (path: string, count: number, branchName: string) => Promise<ResolvedGraph>
    resolveChildBranches: (path: string, baseBranch: string) => Promise<{ children: string[]; merged: string[] }>
    resolveCopyBehavior: (projectId?: string) => Promise<{ behavior: string; customPaths: string[] }>
    getIgnoredFileTree: (repoPath: string) => Promise<IgnoredFileNode[]>
    copyIgnoredFiles: (repoPath: string, worktreePath: string, paths: string[], mode?: 'all' | 'custom') => Promise<void>
    // GitHub CLI (gh)
    checkGhInstalled: () => Promise<boolean>
    hasGithubRemote: (repoPath: string) => Promise<boolean>
    listOpenPrs: (repoPath: string) => Promise<GhPullRequest[]>
    getPrByUrl: (repoPath: string, url: string) => Promise<GhPullRequest | null>
    createPr: (input: CreatePrInput) => Promise<CreatePrResult>
    getPrComments: (repoPath: string, prNumber: number) => Promise<GhPrTimelineEvent[]>
    addPrComment: (repoPath: string, prNumber: number, body: string) => Promise<void>
    mergePr: (input: MergePrInput) => Promise<void>
    getPrDiff: (repoPath: string, prNumber: number) => Promise<string>
    getGhUser: (repoPath: string) => Promise<string>
    editPrComment: (input: EditPrCommentInput) => Promise<void>
    // Stash
    listStashes: (repoPath: string) => Promise<StashEntry[]>
    createStash: (repoPath: string, message: string, includeUntracked: boolean, keepIndex: boolean) => Promise<GitSyncResult>
    applyStash: (repoPath: string, index: number) => Promise<StashApplyResult>
    popStash: (repoPath: string, index: number) => Promise<StashApplyResult>
    dropStash: (repoPath: string, index: number) => Promise<GitSyncResult>
    branchFromStash: (repoPath: string, index: number, branchName: string) => Promise<GitSyncResult>
    getStashDiff: (repoPath: string, index: number) => Promise<string>
    // fs watcher for push-based diff invalidation (replaces renderer polling)
    watchStart: (worktreePath: string) => Promise<void>
    watchStop: (worktreePath: string) => Promise<void>
    onDiffChanged: (cb: (worktreePath: string) => void) => () => void
    onDiffWatchFailed: (cb: (worktreePath: string) => void) => () => void
  }
  tabs: {
    list: (taskId: string) => Promise<TerminalTab[]>
    create: (input: CreateTerminalTabInput) => Promise<TerminalTab>
    update: (input: UpdateTerminalTabInput) => Promise<TerminalTab | null>
    delete: (tabId: string) => Promise<boolean>
    ensureMain: (taskId: string, mode: TerminalMode) => Promise<TerminalTab>
    split: (tabId: string) => Promise<TerminalTab | null>
    moveToGroup: (tabId: string, targetGroupId: string | null) => Promise<TerminalTab | null>
    onChanged: (cb: (payload: { taskId: string; focusTabId?: string | null }) => void) => () => void
  }
  diagnostics: {
    getConfig: () => Promise<DiagnosticsConfig>
    setConfig: (config: Partial<DiagnosticsConfig>) => Promise<DiagnosticsConfig>
    export: (request: DiagnosticsExportRequest) => Promise<DiagnosticsExportResult>
    recordClientError: (input: ClientErrorEventInput) => Promise<void>
    recordClientEvent: (input: ClientDiagnosticEventInput) => Promise<void>
  }
  telemetry: {
    onIpcEvent: (callback: (event: string, props: Record<string, unknown>) => void) => () => void
  }
  aiConfig: {
    listItems: (input: ListAiConfigItemsInput) => Promise<AiConfigItem[]>
    getItem: (id: string) => Promise<AiConfigItem | null>
    createItem: (input: CreateAiConfigItemInput) => Promise<AiConfigItem>
    updateItem: (input: UpdateAiConfigItemInput) => Promise<AiConfigItem | null>
    deleteItem: (id: string) => Promise<boolean>
    listProjectSelections: (projectId: string) => Promise<AiConfigProjectSelection[]>
    setProjectSelection: (input: SetAiConfigProjectSelectionInput) => Promise<void>
    removeProjectSelection: (projectId: string, itemId: string, provider?: string) => Promise<boolean>
    discoverContextFiles: (projectPath: string) => Promise<ContextFileInfo[]>
    readContextFile: (filePath: string, projectPath: string) => Promise<string>
    writeContextFile: (filePath: string, content: string, projectPath: string) => Promise<void>
    getContextTree: (projectPath: string, projectId: string) => Promise<ContextTreeEntry[]>
    reconcileProjectSkills: (projectId: string, projectPath: string) => Promise<number>
    loadLibraryItem: (input: LoadLibraryItemInput) => Promise<ContextTreeEntry>
    syncLinkedFile: (projectId: string, projectPath: string, itemId: string, provider?: CliProvider) => Promise<ContextTreeEntry>
    unlinkFile: (projectId: string, itemId: string) => Promise<boolean>
    renameContextFile: (oldPath: string, newPath: string, projectPath: string) => Promise<void>
    deleteContextFile: (filePath: string, projectPath: string, projectId: string) => Promise<void>
    deleteComputerFile: (filePath: string) => Promise<void>
    createComputerFile: (provider: string, category: 'skill', slug: string) => Promise<ComputerFileEntry>
    writeComputerSkill: (provider: CliProvider, slug: string, content: string) => Promise<void>
    discoverMcpConfigs: (projectPath: string) => Promise<McpConfigFileResult[]>
    writeMcpServer: (input: WriteMcpServerInput) => Promise<void>
    removeMcpServer: (input: RemoveMcpServerInput) => Promise<void>
    discoverComputerMcpConfigs: () => Promise<McpConfigFileResult[]>
    writeComputerMcpServer: (input: WriteComputerMcpServerInput) => Promise<void>
    removeComputerMcpServer: (input: RemoveComputerMcpServerInput) => Promise<void>
    listProviders: () => Promise<CliProviderInfo[]>
    toggleProvider: (id: string, enabled: boolean) => Promise<void>
    getProjectProviders: (projectId: string) => Promise<CliProvider[]>
    setProjectProviders: (projectId: string, providers: CliProvider[]) => Promise<void>
    needsSync: (projectId: string, projectPath: string) => Promise<boolean>
    getProjectStaleSkillCount: (projectId: string, projectPath: string) => Promise<number>
    syncAll: (input: SyncAllInput) => Promise<SyncResult>
    checkSyncStatus: (projectId: string, projectPath: string) => Promise<SyncConflict[]>
    getLibraryInstructions: (variantId?: string) => Promise<string>
    saveLibraryInstructions: (content: string, variantId?: string) => Promise<void>
    listInstructionVariants: () => Promise<AiConfigItem[]>
    getProjectInstructionVariant: (projectId: string) => Promise<AiConfigItem | null>
    setProjectInstructionVariant: (projectId: string, variantItemId: string | null, projectPath?: string) => Promise<void>
    getRootInstructions: (projectId: string, projectPath: string) => Promise<RootInstructionsResult>
    saveInstructionsContent: (projectId: string, projectPath: string, content: string) => Promise<RootInstructionsResult>
    saveRootInstructions: (projectId: string, projectPath: string, content: string) => Promise<RootInstructionsResult>
    readProviderInstructions: (projectPath: string, provider: CliProvider) => Promise<ProviderFileContent>
    pushProviderInstructions: (projectId: string, projectPath: string, provider: CliProvider, content: string) => Promise<RootInstructionsResult>
    pullProviderInstructions: (projectId: string, projectPath: string, provider: CliProvider) => Promise<RootInstructionsResult>
    getProjectSkillsStatus: (projectId: string, projectPath: string) => Promise<ProjectSkillStatus[]>
    readProviderSkill: (projectPath: string, provider: CliProvider, itemId: string) => Promise<ProviderFileContent>
    getExpectedSkillContent: (projectPath: string, provider: CliProvider, itemId: string) => Promise<string>
    pullProviderSkill: (projectId: string, projectPath: string, provider: CliProvider, itemId: string) => Promise<ProjectSkillStatus>
    getComputerFiles: () => Promise<ComputerFileEntry[]>
    checkSlayConfigured: (projectPath: string) => Promise<boolean>
    setupSlay: (projectPath: string, projectId?: string) => Promise<{ ok: boolean; error?: string }>

    // Marketplace
    marketplace: {
      listRegistries: () => Promise<SkillRegistry[]>
      addRegistry: (input: AddRegistryInput) => Promise<SkillRegistry>
      removeRegistry: (registryId: string) => Promise<boolean>
      toggleRegistry: (registryId: string, enabled: boolean) => Promise<void>
      refreshRegistry: (registryId: string) => Promise<SkillRegistryEntry[]>
      refreshAll: () => Promise<void>
      listEntries: (input?: ListEntriesInput) => Promise<SkillRegistryEntry[]>
      installSkill: (input: InstallSkillInput) => Promise<AiConfigItem>
      checkUpdates: () => Promise<SkillUpdateInfo[]>
      updateSkill: (itemId: string, entryId: string) => Promise<AiConfigItem>
      unlinkSkill: (itemId: string) => Promise<AiConfigItem>
      ensureFresh: () => Promise<void>
    }
  }
  fs: {
    readDir: (rootPath: string, dirPath: string) => Promise<DirEntry[]>
    readFile: (rootPath: string, filePath: string, force?: boolean) => Promise<ReadFileResult>
    writeFile: (rootPath: string, filePath: string, content: string) => Promise<void>
    createFile: (rootPath: string, filePath: string) => Promise<void>
    createDir: (rootPath: string, dirPath: string) => Promise<void>
    rename: (rootPath: string, oldPath: string, newPath: string) => Promise<void>
    delete: (rootPath: string, targetPath: string) => Promise<void>
    copy: (rootPath: string, srcPath: string, destPath: string) => Promise<void>
    copyIn: (rootPath: string, absoluteSrc: string, targetDir?: string) => Promise<string>
    showInFinder: (rootPath: string, targetPath: string) => Promise<void>
    listAllFiles: (rootPath: string) => Promise<string[]>
    searchFiles: (rootPath: string, query: string, options?: SearchFilesOptions) => Promise<FileSearchResult[]>
    gitStatus: (rootPath: string) => Promise<GitStatusMap>
    watch: (rootPath: string) => Promise<void>
    unwatch: (rootPath: string) => Promise<void>
    onFileChanged: (callback: (rootPath: string, relPath: string) => void) => () => void
    onFileDeleted: (callback: (rootPath: string, relPath: string) => void) => () => void
  }
  screenshot: {
    captureView: (viewId: string) => Promise<{ success: boolean; path?: string }>
  }
  leaderboard: {
    getLocalStats: () => Promise<LocalLeaderboardStats>
  }
  usage: {
    fetch: (force?: boolean) => Promise<ProviderUsage[]>
    test: (config: UsageProviderConfig) => Promise<{ ok: boolean; windows?: UsageWindow[]; error?: string }>
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
  integrations: {
    connectGithub: (input: ConnectGithubInput) => Promise<IntegrationConnectionPublic>
    connectLinear: (input: ConnectLinearInput) => Promise<IntegrationConnectionPublic>
    connectJira: (input: ConnectJiraInput) => Promise<IntegrationConnectionPublic>
    getJiraTransitions: (taskId: string) => Promise<JiraTransition[]>
    updateConnection: (input: UpdateIntegrationConnectionInput) => Promise<IntegrationConnectionPublic>
    listConnections: (provider?: IntegrationProvider) => Promise<IntegrationConnectionPublic[]>
    getConnectionUsage: (connectionId: string) => Promise<IntegrationConnectionUsage>
    disconnect: (connectionId: string) => Promise<boolean>
    clearProjectProvider: (input: ClearProjectProviderInput) => Promise<boolean>
    getProjectConnection: (projectId: string, provider: IntegrationProvider) => Promise<string | null>
    setProjectConnection: (input: SetProjectConnectionInput) => Promise<boolean>
    clearProjectConnection: (input: ClearProjectConnectionInput) => Promise<boolean>
    listGithubRepositories: (connectionId: string) => Promise<GithubRepositorySummary[]>
    listGithubProjects: (connectionId: string) => Promise<GithubProjectSummary[]>
    listGithubIssues: (
      input: ListGithubIssuesInput
    ) => Promise<{ issues: GithubIssueSummary[]; nextCursor: string | null }>
    importGithubIssues: (input: ImportGithubIssuesInput) => Promise<ImportGithubIssuesResult>
    listGithubRepositoryIssues: (
      input: ListGithubRepositoryIssuesInput
    ) => Promise<{ issues: GithubIssueSummary[]; nextCursor: string | null }>
    importGithubRepositoryIssues: (
      input: ImportGithubRepositoryIssuesInput
    ) => Promise<ImportGithubRepositoryIssuesResult>
    listLinearTeams: (connectionId: string) => Promise<{ teams: LinearTeam[]; orgUrlKey: string }>
    listLinearProjects: (connectionId: string, teamId: string) => Promise<LinearProject[]>
    listLinearIssues: (
      input: ListLinearIssuesInput
    ) => Promise<{ issues: LinearIssueSummary[]; nextCursor: string | null }>
    setProjectMapping: (input: SetProjectMappingInput) => Promise<IntegrationProjectMapping>
    getProjectMapping: (projectId: string, provider: IntegrationProvider) => Promise<IntegrationProjectMapping | null>
    importLinearIssues: (input: ImportLinearIssuesInput) => Promise<ImportLinearIssuesResult>
    syncNow: (input: SyncNowInput) => Promise<SyncNowResult>
    getTaskSyncStatus: (taskId: string, provider: IntegrationProvider) => Promise<TaskSyncStatus>
    getBatchTaskSyncStatus: (taskIds: string[], provider: IntegrationProvider) => Promise<BatchTaskSyncStatusItem[]>
    pushTask: (input: PushTaskInput) => Promise<PushTaskResult>
    pullTask: (input: PullTaskInput) => Promise<PullTaskResult>
    getLink: (taskId: string, provider: IntegrationProvider) => Promise<ExternalLink | null>
    unlinkTask: (taskId: string, provider: IntegrationProvider) => Promise<boolean>
    pushUnlinkedTasks: (input: PushUnlinkedTasksInput) => Promise<PushUnlinkedTasksResult>
    fetchProviderStatuses: (input: FetchProviderStatusesInput) => Promise<ProviderStatus[]>
    applyStatusSync: (input: ApplyStatusSyncInput) => Promise<Project>
    resyncProviderStatuses: (input: { projectId: string; provider: IntegrationProvider }) => Promise<StatusResyncPreview>
    // Generic provider-dispatched methods
    listProviderGroups: (connectionId: string) => Promise<ExternalGroup[]>
    listProviderScopes: (connectionId: string, groupId: string) => Promise<ExternalScope[]>
    listProviderIssues: (
      input: ListProviderIssuesInput
    ) => Promise<{ issues: NormalizedIssue[]; nextCursor: string | null }>
    importProviderIssues: (input: ImportProviderIssuesInput) => Promise<ImportProviderIssuesResult>
  }
  exportImport: {
    exportAll: () => Promise<{ success: boolean; canceled?: boolean; path?: string; error?: string }>
    exportProject: (projectId: string) => Promise<{ success: boolean; canceled?: boolean; path?: string; error?: string }>
    import: () => Promise<{ success: boolean; canceled?: boolean; projectCount?: number; taskCount?: number; importedProjects?: Array<{ id: string; name: string }>; error?: string }>
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
  backup: {
    list: () => Promise<BackupInfo[]>
    create: (name?: string) => Promise<BackupInfo>
    rename: (filename: string, name: string) => Promise<void>
    delete: (filename: string) => Promise<void>
    restore: (filename: string) => Promise<void>
    getSettings: () => Promise<BackupSettings>
    setSettings: (settings: Partial<BackupSettings>) => Promise<BackupSettings>
    revealInFinder: () => Promise<void>
  }
  testPanel: {
    getCategories: (projectId: string) => Promise<TestCategory[]>
    createCategory: (data: CreateTestCategoryInput) => Promise<TestCategory>
    updateCategory: (data: UpdateTestCategoryInput) => Promise<TestCategory>
    deleteCategory: (id: string) => Promise<boolean>
    reorderCategories: (ids: string[]) => Promise<void>
    getProfiles: () => Promise<TestProfile[]>
    saveProfile: (profile: TestProfile) => Promise<void>
    deleteProfile: (id: string) => Promise<void>
    applyProfile: (projectId: string, profileId: string) => Promise<TestCategory[]>
    scanFiles: (projectPath: string, projectId: string) => Promise<ScanResult>
    getLabels: (projectId: string) => Promise<TestLabel[]>
    createLabel: (data: CreateTestLabelInput) => Promise<TestLabel>
    updateLabel: (data: UpdateTestLabelInput) => Promise<TestLabel>
    deleteLabel: (id: string) => Promise<boolean>
    getFileLabels: (projectId: string) => Promise<TestFileLabel[]>
    toggleFileLabel: (projectId: string, filePath: string, labelId: string) => Promise<void>
    getFileNotes: (projectId: string) => Promise<TestFileNote[]>
    setFileNote: (projectId: string, filePath: string, note: string) => Promise<void>
  }

  automations: {
    getByProject: (projectId: string) => Promise<Automation[]>
    get: (id: string) => Promise<Automation | null>
    create: (data: CreateAutomationInput) => Promise<Automation>
    update: (data: UpdateAutomationInput) => Promise<Automation>
    delete: (id: string) => Promise<boolean>
    toggle: (id: string, enabled: boolean) => Promise<Automation>
    reorder: (ids: string[]) => Promise<void>
    getRuns: (automationId: string, limit?: number) => Promise<AutomationRun[]>
    runManual: (id: string) => Promise<AutomationRun>
    clearRuns: (automationId: string) => Promise<void>
    onChanged: (callback: () => void) => () => void
  }

  usageAnalytics: {
    query: (range: import('@slayzone/usage-analytics/shared').DateRange) => Promise<import('@slayzone/usage-analytics/shared').AnalyticsSummary>
    refresh: (range: import('@slayzone/usage-analytics/shared').DateRange) => Promise<import('@slayzone/usage-analytics/shared').AnalyticsSummary>
    taskCost: (taskId: string) => Promise<{
      totalTokens: number
      byProvider: Array<{ provider: string; model: string; totalTokens: number; sessions: number }>
    }>
  }
}
