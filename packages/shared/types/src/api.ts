import type { Project, CreateProjectInput, UpdateProjectInput, ExecutionContext } from '@slayzone/projects/shared'
import type { Task, CreateTaskInput, UpdateTaskInput, GenerateDescriptionResult, DesktopHandoffPolicy } from '@slayzone/task/shared'
import type { Tag, CreateTagInput, UpdateTagInput } from '@slayzone/tags/shared'
import type {
  TerminalMode,
  TerminalState,
  PtyInfo,
  PromptInfo,
  BufferSinceResult,
  ProviderUsage,
  UsageWindow,
  UsageProviderConfig,
  ValidationResult,
  TerminalModeInfo,
  CreateTerminalModeInput,
  UpdateTerminalModeInput
} from '@slayzone/terminal/shared'
import type { TerminalTab, CreateTerminalTabInput, UpdateTerminalTabInput } from '@slayzone/task-terminals/shared'
import type { Theme, ThemePreference } from '@slayzone/settings/shared'
import type { DetectedWorktree, MergeResult, MergeWithAIResult, GitDiffSnapshot, GitSyncResult, ConflictFileContent, ConflictAnalysis, RebaseProgress, CommitInfo, AheadBehind, StatusSummary, GhPullRequest, GhPrComment, CreatePrInput, CreatePrResult, MergePrInput, EditPrCommentInput } from '@slayzone/worktrees/shared'
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
  LoadGlobalItemInput,
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
  GlobalFileEntry
} from '@slayzone/ai-config/shared'
import type { DirEntry, ReadFileResult, FileSearchResult, SearchFilesOptions } from '@slayzone/file-editor/shared'
import type { TestCategory, CreateTestCategoryInput, UpdateTestCategoryInput, TestProfile, ScanResult, TestLabel, CreateTestLabelInput, UpdateTestLabelInput, TestFileLabel, TestFileNote } from '@slayzone/test-panel/shared'
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
  StatusResyncPreview
} from '@slayzone/integrations/shared'

export type { ExecutionContext } from '@slayzone/projects/shared'

export interface BackupInfo {
  filename: string
  name: string
  timestamp: string
  type: 'auto' | 'manual'
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
}

// ElectronAPI interface - the IPC contract between renderer and main
export interface ElectronAPI {
  ai: {
    generateDescription: (title: string, mode: TerminalMode) => Promise<GenerateDescriptionResult>
  }
  db: {
    // Projects
    getProjects: () => Promise<Project[]>
    createProject: (data: CreateProjectInput) => Promise<Project>
    updateProject: (data: UpdateProjectInput) => Promise<Project>
    deleteProject: (id: string) => Promise<boolean>

    // Tasks
    getTasks: () => Promise<Task[]>
    getTasksByProject: (projectId: string) => Promise<Task[]>
    getTask: (id: string) => Promise<Task | null>
    getSubTasks: (parentId: string) => Promise<Task[]>
    createTask: (data: CreateTaskInput) => Promise<Task>
    updateTask: (data: UpdateTaskInput) => Promise<Task>
    deleteTask: (id: string) => Promise<boolean>
    restoreTask: (id: string) => Promise<Task>
    archiveTask: (id: string) => Promise<Task>
    archiveTasks: (ids: string[]) => Promise<void>
    unarchiveTask: (id: string) => Promise<Task>
    getArchivedTasks: () => Promise<Task[]>
    reorderTasks: (taskIds: string[]) => Promise<void>
  }
  tags: {
    getTags: () => Promise<Tag[]>
    createTag: (data: CreateTagInput) => Promise<Tag>
    updateTag: (data: UpdateTagInput) => Promise<Tag>
    deleteTag: (id: string) => Promise<boolean>
  }
  taskTags: {
    getAll: () => Promise<Record<string, string[]>>
    getTagsForTask: (taskId: string) => Promise<Tag[]>
    setTagsForTask: (taskId: string, tagIds: string[]) => Promise<void>
  }
  taskDependencies: {
    getAllBlockedTaskIds: () => Promise<string[]>
    getBlockers: (taskId: string) => Promise<Task[]>
    getBlocking: (taskId: string) => Promise<Task[]>
    addBlocker: (taskId: string, blockerTaskId: string) => Promise<void>
    removeBlocker: (taskId: string, blockerTaskId: string) => Promise<void>
    setBlockers: (taskId: string, blockerTaskIds: string[]) => Promise<void>
  }
  settings: {
    get: (key: string) => Promise<string | null>
    set: (key: string, value: string) => Promise<void>
    getAll: () => Promise<Record<string, string>>
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
      properties?: Array<'openFile' | 'openDirectory' | 'multiSelections'>
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
    isContextManagerEnabled: () => Promise<boolean>
    isContextManagerEnabledSync: boolean
    isIntegrationsEnabled: boolean
    isPlaywright: boolean
    onGoHome: (callback: () => void) => () => void
    onOpenSettings: (callback: () => void) => () => void
    onOpenProjectSettings: (callback: () => void) => () => void
    onNewTemporaryTask: (callback: () => void) => () => void
    onTasksChanged: (callback: () => void) => () => void
    onCloseTask: (callback: (taskId: string) => void) => () => void
    onOpenTask: (callback: (taskId: string) => void) => () => void
    onScreenshotTrigger: (callback: () => void) => () => void
    onUpdateStatus: (callback: (status: UpdateStatus) => void) => () => void
    onCloseCurrent: (callback: () => void) => () => void
    onReloadBrowser: (callback: () => void) => () => void
    onCloseActiveTask: (callback: () => void) => () => void
    dataReady: () => void
    restartForUpdate: () => Promise<void>
    checkForUpdates: () => Promise<void>
    cliStatus: () => Promise<{ installed: boolean }>
    installCli: () => Promise<{ ok: boolean; permissionDenied?: boolean; error?: string }>
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
  }
  pty: {
    create: (opts: PtyCreateOptions) => Promise<{ success: boolean; error?: string }>
    testExecutionContext: (context: ExecutionContext) => Promise<{ success: boolean; error?: string }>
    ccsListProfiles: () => Promise<{ profiles: string[]; error?: string }>
    write: (sessionId: string, data: string) => Promise<boolean>
    resize: (sessionId: string, cols: number, rows: number) => Promise<boolean>
    kill: (sessionId: string) => Promise<boolean>
    exists: (sessionId: string) => Promise<boolean>
    getBuffer: (sessionId: string) => Promise<string | null>
    clearBuffer: (
      sessionId: string
    ) => Promise<{ success: boolean; clearedSeq: number | null }>
    getBufferSince: (sessionId: string, afterSeq: number) => Promise<BufferSinceResult | null>
    list: () => Promise<PtyInfo[]>
    dismissAllNotifications: () => Promise<void>
    onData: (callback: (sessionId: string, data: string, seq: number) => void) => () => void
    onExit: (callback: (sessionId: string, exitCode: number) => void) => () => void
    onSessionNotFound: (callback: (sessionId: string) => void) => () => void
    onAttention: (callback: (sessionId: string) => void) => () => void
    onStateChange: (
      callback: (sessionId: string, newState: TerminalState, oldState: TerminalState) => void
    ) => () => void
    onPrompt: (callback: (sessionId: string, prompt: PromptInfo) => void) => () => void
    onSessionDetected: (callback: (sessionId: string, conversationId: string) => void) => () => void
    onDevServerDetected: (callback: (sessionId: string, url: string) => void) => () => void
    getState: (sessionId: string) => Promise<TerminalState | null>
    validate: (mode: TerminalMode) => Promise<ValidationResult[]>
    setTheme: (theme: { foreground: string; background: string; cursor: string }) => Promise<void>
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
    detectWorktrees: (repoPath: string) => Promise<DetectedWorktree[]>
    createWorktree: (repoPath: string, targetPath: string, branch?: string, sourceBranch?: string) => Promise<{ setupResult: { ran: boolean; success?: boolean; output?: string } }>
    removeWorktree: (repoPath: string, worktreePath: string) => Promise<void>
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
    getWorkingDiff: (path: string, opts?: { contextLines?: string; ignoreWhitespace?: boolean }) => Promise<GitDiffSnapshot>
    stageFile: (path: string, filePath: string) => Promise<void>
    unstageFile: (path: string, filePath: string) => Promise<void>
    discardFile: (path: string, filePath: string, untracked?: boolean) => Promise<void>
    stageAll: (path: string) => Promise<void>
    unstageAll: (path: string) => Promise<void>
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
    // GitHub CLI (gh)
    checkGhInstalled: () => Promise<boolean>
    hasGithubRemote: (repoPath: string) => Promise<boolean>
    listOpenPrs: (repoPath: string) => Promise<GhPullRequest[]>
    getPrByUrl: (repoPath: string, url: string) => Promise<GhPullRequest | null>
    createPr: (input: CreatePrInput) => Promise<CreatePrResult>
    getPrComments: (repoPath: string, prNumber: number) => Promise<GhPrComment[]>
    addPrComment: (repoPath: string, prNumber: number, body: string) => Promise<void>
    mergePr: (input: MergePrInput) => Promise<void>
    getPrDiff: (repoPath: string, prNumber: number) => Promise<string>
    getGhUser: (repoPath: string) => Promise<string>
    editPrComment: (input: EditPrCommentInput) => Promise<void>
  }
  tabs: {
    list: (taskId: string) => Promise<TerminalTab[]>
    create: (input: CreateTerminalTabInput) => Promise<TerminalTab>
    update: (input: UpdateTerminalTabInput) => Promise<TerminalTab | null>
    delete: (tabId: string) => Promise<boolean>
    ensureMain: (taskId: string, mode: TerminalMode) => Promise<TerminalTab>
    split: (tabId: string) => Promise<TerminalTab | null>
    moveToGroup: (tabId: string, targetGroupId: string | null) => Promise<TerminalTab | null>
  }
  diagnostics: {
    getConfig: () => Promise<DiagnosticsConfig>
    setConfig: (config: Partial<DiagnosticsConfig>) => Promise<DiagnosticsConfig>
    export: (request: DiagnosticsExportRequest) => Promise<DiagnosticsExportResult>
    recordClientError: (input: ClientErrorEventInput) => Promise<void>
    recordClientEvent: (input: ClientDiagnosticEventInput) => Promise<void>
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
    loadGlobalItem: (input: LoadGlobalItemInput) => Promise<ContextTreeEntry>
    syncLinkedFile: (projectId: string, projectPath: string, itemId: string, provider?: CliProvider) => Promise<ContextTreeEntry>
    unlinkFile: (projectId: string, itemId: string) => Promise<boolean>
    renameContextFile: (oldPath: string, newPath: string, projectPath: string) => Promise<void>
    deleteContextFile: (filePath: string, projectPath: string, projectId: string) => Promise<void>
    deleteGlobalFile: (filePath: string) => Promise<void>
    createGlobalFile: (provider: CliProvider, category: 'skill', slug: string) => Promise<GlobalFileEntry>
    discoverMcpConfigs: (projectPath: string) => Promise<McpConfigFileResult[]>
    writeMcpServer: (input: WriteMcpServerInput) => Promise<void>
    removeMcpServer: (input: RemoveMcpServerInput) => Promise<void>
    listProviders: () => Promise<CliProviderInfo[]>
    toggleProvider: (id: string, enabled: boolean) => Promise<void>
    getProjectProviders: (projectId: string) => Promise<CliProvider[]>
    setProjectProviders: (projectId: string, providers: CliProvider[]) => Promise<void>
    needsSync: (projectId: string, projectPath: string) => Promise<boolean>
    syncAll: (input: SyncAllInput) => Promise<SyncResult>
    checkSyncStatus: (projectId: string, projectPath: string) => Promise<SyncConflict[]>
    getGlobalInstructions: () => Promise<string>
    saveGlobalInstructions: (content: string) => Promise<void>
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
    getGlobalFiles: () => Promise<GlobalFileEntry[]>
  }
  fs: {
    readDir: (rootPath: string, dirPath: string) => Promise<DirEntry[]>
    readFile: (rootPath: string, filePath: string, force?: boolean) => Promise<ReadFileResult>
    writeFile: (rootPath: string, filePath: string, content: string) => Promise<void>
    createFile: (rootPath: string, filePath: string) => Promise<void>
    createDir: (rootPath: string, dirPath: string) => Promise<void>
    rename: (rootPath: string, oldPath: string, newPath: string) => Promise<void>
    delete: (rootPath: string, targetPath: string) => Promise<void>
    copyIn: (rootPath: string, absoluteSrc: string) => Promise<string>
    listAllFiles: (rootPath: string) => Promise<string[]>
    searchFiles: (rootPath: string, query: string, options?: SearchFilesOptions) => Promise<FileSearchResult[]>
    watch: (rootPath: string) => Promise<void>
    unwatch: (rootPath: string) => Promise<void>
    onFileChanged: (callback: (rootPath: string, relPath: string) => void) => () => void
  }
  screenshot: {
    captureRegion: (rect: {
      x: number
      y: number
      width: number
      height: number
    }) => Promise<{ success: boolean; path?: string }>
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
    setDesktopHandoffPolicy: (webviewId: number, policy: DesktopHandoffPolicy | null) => Promise<boolean>
    onShortcut: (callback: (payload: { key: string; shift?: boolean; webviewId?: number }) => void) => () => void
    openDevToolsBottom: (webviewId: number) => Promise<boolean>
    openDevToolsInline: (targetWebviewId: number, bounds: { x: number; y: number; width: number; height: number }) => Promise<{
      ok: boolean
      reason: string
      targetType?: string
      hostType?: string
      mode?: 'right' | 'bottom'
      deviceToolbar?: string
      attempts?: string[]
      error?: string
    }>
    updateDevToolsInlineBounds: (bounds: { x: number; y: number; width: number; height: number }) => Promise<boolean>
    closeDevToolsInline: (targetWebviewId?: number) => Promise<boolean>
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
    registerBrowserPanel: (taskId: string, webContentsId: number) => Promise<void>
    unregisterBrowserPanel: (taskId: string) => Promise<void>
  }
  integrations: {
    connectGithub: (input: ConnectGithubInput) => Promise<IntegrationConnectionPublic>
    connectLinear: (input: ConnectLinearInput) => Promise<IntegrationConnectionPublic>
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
    pushTask: (input: PushTaskInput) => Promise<PushTaskResult>
    pullTask: (input: PullTaskInput) => Promise<PullTaskResult>
    getLink: (taskId: string, provider: IntegrationProvider) => Promise<ExternalLink | null>
    unlinkTask: (taskId: string, provider: IntegrationProvider) => Promise<boolean>
    fetchProviderStatuses: (input: FetchProviderStatusesInput) => Promise<ProviderStatus[]>
    applyStatusSync: (input: ApplyStatusSyncInput) => Promise<Project>
    resyncProviderStatuses: (input: { projectId: string; provider: IntegrationProvider }) => Promise<StatusResyncPreview>
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
    kill: (processId: string) => Promise<boolean>
    restart: (processId: string) => Promise<boolean>
    listForTask: (taskId: string | null, projectId: string | null) => Promise<ProcessInfo[]>
    listAll: () => Promise<ProcessInfo[]>
    killTask: (taskId: string) => Promise<void>
    onLog: (cb: (processId: string, line: string) => void) => () => void
    onStatus: (cb: (processId: string, status: ProcessStatus) => void) => () => void
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
}
