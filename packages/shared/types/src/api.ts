import type {
  Project,
  CreateProjectInput,
  UpdateProjectInput,
  ProjectFeatureSyncAggregateResult,
  RepoFeatureSyncConfig,
  ProjectFeatureSyncResult,
  TaskFeatureDetails,
  UpdateTaskFeatureInput
} from '@slayzone/projects/shared'
import type { Task, CreateTaskInput, UpdateTaskInput, DesktopHandoffPolicy } from '@slayzone/task/shared'
import type { Tag, CreateTagInput, UpdateTagInput } from '@slayzone/tags/shared'
import type { Theme, ThemePreference } from '@slayzone/settings/shared'
import type { TerminalMode, TerminalState, CodeMode, PtyInfo, PromptInfo, BufferSinceResult, ProviderUsage, ValidationResult, ExecutionContext } from '@slayzone/terminal/shared'
import type { TerminalTab, CreateTerminalTabInput, UpdateTerminalTabInput } from '@slayzone/task-terminals/shared'
import type { DetectedWorktree, MergeResult, MergeWithAIResult, GitDiffSnapshot, ConflictFileContent, ConflictAnalysis, RebaseProgress, CommitInfo, AheadBehind, StatusSummary } from '@slayzone/worktrees/shared'
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
import type {
  ConnectLinearInput,
  ExternalLink,
  ImportLinearIssuesInput,
  ImportLinearIssuesResult,
  IntegrationConnectionPublic,
  IntegrationProjectMapping,
  IntegrationProvider,
  ListLinearIssuesInput,
  LinearIssueSummary,
  LinearProject,
  LinearTeam,
  SetProjectMappingInput,
  SyncNowInput,
  SyncNowResult
} from '@slayzone/integrations/shared'

export type { ExecutionContext } from '@slayzone/terminal/shared'

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
  codeMode?: CodeMode | null
  providerFlags?: string | null
  executionContext?: ExecutionContext | null
  ccsProfile?: string | null
}

// ElectronAPI interface - the IPC contract between renderer and main
export interface ElectronAPI {
  db: {
    // Projects
    getProjects: () => Promise<Project[]>
    createProject: (data: CreateProjectInput) => Promise<Project>
    updateProject: (data: UpdateProjectInput) => Promise<Project>
    syncProjectFeatures: (projectId: string) => Promise<ProjectFeatureSyncResult>
    syncAllProjectFeatures: () => Promise<ProjectFeatureSyncAggregateResult>
    getProjectFeatureSyncConfig: () => Promise<RepoFeatureSyncConfig>
    setProjectFeatureSyncConfig: (input: Partial<RepoFeatureSyncConfig>) => Promise<RepoFeatureSyncConfig>
    deleteProject: (id: string) => Promise<boolean>

    // Tasks
    getTasks: () => Promise<Task[]>
    getTasksByProject: (projectId: string) => Promise<Task[]>
    getTask: (id: string) => Promise<Task | null>
    getTaskFeatureContext: (taskId: string) => Promise<{
      featureFilePath: string
      featureDirPath: string
      featureDirAbsolutePath: string | null
    } | null>
    getTaskFeatureDetails: (taskId: string) => Promise<TaskFeatureDetails | null>
    syncTaskFeatureFromRepo: (taskId: string) => Promise<{
      updated: boolean
      task: Task | null
      details: TaskFeatureDetails | null
      sync: ProjectFeatureSyncResult
    }>
    syncTaskFeatureToRepo: (taskId: string) => Promise<{
      updated: boolean
      task: Task | null
      details: TaskFeatureDetails | null
    }>
    createTaskFeature: (
      taskId: string,
      input?: {
        featureId?: string | null
        folderName?: string | null
        title?: string | null
        description?: string | null
      }
    ) => Promise<{
      created: boolean
      featureFilePath: string
      task: Task | null
      details: TaskFeatureDetails | null
    }>
    deleteTaskFeature: (taskId: string) => Promise<{
      deleted: boolean
      task: Task | null
      details: TaskFeatureDetails | null
    }>
    updateTaskFeature: (
      taskId: string,
      input: UpdateTaskFeatureInput
    ) => Promise<{
      updated: boolean
      task: Task | null
      details: TaskFeatureDetails | null
    }>
    getSubTasks: (parentId: string) => Promise<Task[]>
    createTask: (data: CreateTaskInput) => Promise<Task>
    updateTask: (data: UpdateTaskInput) => Promise<Task>
    deleteTask: (id: string, options?: { deleteFeatureDir?: boolean }) => Promise<boolean>
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
    githubPopupSignIn: (signInUrl: string, callbackUrl: string) => Promise<{
      ok: boolean
      code?: string
      error?: string
      cancelled?: boolean
    }>
    openSystemSignIn: (signInUrl: string) => Promise<void>
    onOAuthCallback: (callback: (payload: { code?: string; error?: string }) => void) => () => void
    consumeOAuthCallback: () => Promise<{ code?: string; error?: string } | null>
  }
  dialog: {
    showOpenDialog: (options: {
      title?: string
      defaultPath?: string
      properties?: Array<'openFile' | 'openDirectory' | 'multiSelections'>
    }) => Promise<{ canceled: boolean; filePaths: string[] }>
  }
  app: {
    getVersion: () => Promise<string>
    isContextManagerEnabled: () => Promise<boolean>
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
    openProjectSettings: () => Promise<void>
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
    setCcsEnabled: (enabled: boolean) => Promise<void>
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
    fetch: () => Promise<ProviderUsage[]>
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
    connectLinear: (input: ConnectLinearInput) => Promise<IntegrationConnectionPublic>
    listConnections: (provider?: IntegrationProvider) => Promise<IntegrationConnectionPublic[]>
    disconnect: (connectionId: string) => Promise<boolean>
    listLinearTeams: (connectionId: string) => Promise<LinearTeam[]>
    listLinearProjects: (connectionId: string, teamId: string) => Promise<LinearProject[]>
    listLinearIssues: (
      input: ListLinearIssuesInput
    ) => Promise<{ issues: LinearIssueSummary[]; nextCursor: string | null }>
    setProjectMapping: (input: SetProjectMappingInput) => Promise<IntegrationProjectMapping>
    getProjectMapping: (projectId: string, provider: IntegrationProvider) => Promise<IntegrationProjectMapping | null>
    importLinearIssues: (input: ImportLinearIssuesInput) => Promise<ImportLinearIssuesResult>
    syncNow: (input: SyncNowInput) => Promise<SyncNowResult>
    getLink: (taskId: string, provider: IntegrationProvider) => Promise<ExternalLink | null>
    unlinkTask: (taskId: string, provider: IntegrationProvider) => Promise<boolean>
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
}
