import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { ElectronAPI } from '@slayzone/types'
import type { TerminalState, PromptInfo } from '@slayzone/terminal/shared'

// Prevent Electron's default file drop behavior (navigates to the file).
// Must be in the preload's main world — isolated world's preventDefault alone
// may not be seen by Chromium's drop allowance check.
let lastDropPaths: string[] = []
window.addEventListener('dragover', (e) => e.preventDefault(), true)
window.addEventListener('drop', (e) => {
  e.preventDefault()
  if (!e.dataTransfer?.files.length) return
  lastDropPaths = Array.from(e.dataTransfer.files).map((f) => webUtils.getPathForFile(f))
}, true)

// Custom APIs for renderer
const api: ElectronAPI = {
  db: {
    // Projects
    getProjects: () => ipcRenderer.invoke('db:projects:getAll'),
    createProject: (data) => ipcRenderer.invoke('db:projects:create', data),
    updateProject: (data) => ipcRenderer.invoke('db:projects:update', data),
    deleteProject: (id) => ipcRenderer.invoke('db:projects:delete', id),
    reorderProjects: (projectIds) => ipcRenderer.invoke('db:projects:reorder', projectIds),

    // Tasks
    getTasks: () => ipcRenderer.invoke('db:tasks:getAll'),
    loadBoardData: () => ipcRenderer.invoke('db:loadBoardData'),
    getTasksByProject: (projectId) => ipcRenderer.invoke('db:tasks:getByProject', projectId),
    getTask: (id) => ipcRenderer.invoke('db:tasks:get', id),
    getSubTasks: (parentId) => ipcRenderer.invoke('db:tasks:getSubTasks', parentId),
    createTask: (data) => ipcRenderer.invoke('db:tasks:create', data),
    updateTask: (data) => ipcRenderer.invoke('db:tasks:update', data),
    deleteTask: (id) => ipcRenderer.invoke('db:tasks:delete', id),
    restoreTask: (id) => ipcRenderer.invoke('db:tasks:restore', id),
    archiveTask: (id) => ipcRenderer.invoke('db:tasks:archive', id),
    archiveTasks: (ids) => ipcRenderer.invoke('db:tasks:archiveMany', ids),
    unarchiveTask: (id) => ipcRenderer.invoke('db:tasks:unarchive', id),
    getArchivedTasks: () => ipcRenderer.invoke('db:tasks:getArchived'),
    reorderTasks: (taskIds) => ipcRenderer.invoke('db:tasks:reorder', taskIds)
  },
  tags: {
    getTags: () => ipcRenderer.invoke('db:tags:getAll'),
    createTag: (data) => ipcRenderer.invoke('db:tags:create', data),
    updateTag: (data) => ipcRenderer.invoke('db:tags:update', data),
    deleteTag: (id) => ipcRenderer.invoke('db:tags:delete', id),
    reorderTags: (tagIds) => ipcRenderer.invoke('db:tags:reorder', tagIds)
  },
  taskTags: {
    getAll: () => ipcRenderer.invoke('db:taskTags:getAll'),
    getTagsForTask: (taskId) => ipcRenderer.invoke('db:taskTags:getForTask', taskId),
    setTagsForTask: (taskId, tagIds) => ipcRenderer.invoke('db:taskTags:setForTask', taskId, tagIds)
  },
  taskDependencies: {
    getAllBlockedTaskIds: () => ipcRenderer.invoke('db:taskDependencies:getAllBlockedTaskIds'),
    getBlockers: (taskId) => ipcRenderer.invoke('db:taskDependencies:getBlockers', taskId),
    getBlocking: (taskId) => ipcRenderer.invoke('db:taskDependencies:getBlocking', taskId),
    addBlocker: (taskId, blockerTaskId) =>
      ipcRenderer.invoke('db:taskDependencies:addBlocker', taskId, blockerTaskId),
    removeBlocker: (taskId, blockerTaskId) =>
      ipcRenderer.invoke('db:taskDependencies:removeBlocker', taskId, blockerTaskId),
    setBlockers: (taskId, blockerTaskIds) =>
      ipcRenderer.invoke('db:taskDependencies:setBlockers', taskId, blockerTaskIds)
  },
  feedback: {
    listThreads: () => ipcRenderer.invoke('db:feedback:listThreads'),
    createThread: (input) => ipcRenderer.invoke('db:feedback:createThread', input),
    getMessages: (threadId) => ipcRenderer.invoke('db:feedback:getMessages', threadId),
    addMessage: (input) => ipcRenderer.invoke('db:feedback:addMessage', input),
    updateThreadDiscordId: (threadId, discordThreadId) => ipcRenderer.invoke('db:feedback:updateThreadDiscordId', threadId, discordThreadId),
    deleteThread: (threadId) => ipcRenderer.invoke('db:feedback:deleteThread', threadId),
  },
  settings: {
    get: (key) => ipcRenderer.invoke('db:settings:get', key),
    set: (key, value) => ipcRenderer.invoke('db:settings:set', key, value),
    getAll: () => ipcRenderer.invoke('db:settings:getAll')
  },
  shortcuts: {
    changed: () => ipcRenderer.send('shortcuts:changed'),
  },
  theme: {
    getEffective: () => ipcRenderer.invoke('theme:get-effective'),
    getSource: () => ipcRenderer.invoke('theme:get-source'),
    set: (theme: 'light' | 'dark' | 'system') => ipcRenderer.invoke('theme:set', theme),
    onChange: (callback: (theme: 'light' | 'dark') => void) => {
      const handler = (_event: unknown, theme: 'light' | 'dark') => callback(theme)
      ipcRenderer.on('theme:changed', handler)
      return () => ipcRenderer.removeListener('theme:changed', handler)
    }
  },
  shell: {
    openExternal: (
      url: string,
      options?: {
        blockDesktopHandoff?: boolean
        desktopHandoff?: import('@slayzone/task/shared').DesktopHandoffPolicy
      }
    ) =>
      ipcRenderer.invoke('shell:open-external', url, options)
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
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    isContextManagerEnabled: () => ipcRenderer.invoke('app:is-context-manager-enabled'),
    isContextManagerEnabledSync: ipcRenderer.sendSync('app:is-context-manager-enabled-sync') as boolean,
    isTestsPanelEnabled: () => ipcRenderer.invoke('app:is-tests-panel-enabled'),
    isTestsPanelEnabledSync: ipcRenderer.sendSync('app:is-tests-panel-enabled-sync') as boolean,
    isJiraIntegrationEnabled: () => ipcRenderer.invoke('app:is-jira-integration-enabled'),
    isJiraIntegrationEnabledSync: ipcRenderer.sendSync('app:is-jira-integration-enabled-sync') as boolean,
    isPlaywright: process.env.PLAYWRIGHT === '1',
    onGoHome: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('app:go-home', handler)
      return () => ipcRenderer.removeListener('app:go-home', handler)
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
    onCloseTask: (callback: (taskId: string) => void) => {
      const handler = (_: unknown, taskId: string) => callback(taskId)
      ipcRenderer.on('app:close-task', handler)
      return () => ipcRenderer.removeListener('app:close-task', handler)
    },
    onBrowserEnsurePanelOpen: (callback: (taskId: string, url?: string) => void) => {
      const handler = (_: unknown, taskId: string, url?: string) => callback(taskId, url)
      ipcRenderer.on('browser:ensure-panel-open', handler)
      return () => ipcRenderer.removeListener('browser:ensure-panel-open', handler)
    },
    onOpenTask: (callback: (taskId: string) => void) => {
      const handler = (_: unknown, taskId: string) => callback(taskId)
      ipcRenderer.on('app:open-task', handler)
      return () => ipcRenderer.removeListener('app:open-task', handler)
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
    restartForUpdate: () => ipcRenderer.invoke('app:restart-for-update'),
    checkForUpdates: () => ipcRenderer.invoke('app:check-for-updates'),
    cliStatus: () => ipcRenderer.invoke('app:cli-status'),
    installCli: () => ipcRenderer.invoke('app:install-cli')
  },
  window: {
    close: () => ipcRenderer.invoke('window:close')
  },
  files: {
    saveTempImage: (base64, mimeType) => ipcRenderer.invoke('files:saveTempImage', base64, mimeType),
    pathExists: (path) => ipcRenderer.invoke('files:pathExists', path),
    getDropPaths: () => {
      const paths = lastDropPaths
      lastDropPaths = []
      return paths
    }
  },
  pty: {
    create: (opts) => ipcRenderer.invoke('pty:create', opts),
    testExecutionContext: (context) => ipcRenderer.invoke('pty:testExecutionContext', context),
    ccsListProfiles: () => ipcRenderer.invoke('pty:ccsListProfiles'),
    write: (sessionId, data) => ipcRenderer.invoke('pty:write', sessionId, data),
    setTheme: (theme) => ipcRenderer.invoke('pty:set-theme', theme),
    setShellOverride: (value) => ipcRenderer.invoke('pty:setShellOverride', value),
    resize: (sessionId, cols, rows) => ipcRenderer.invoke('pty:resize', sessionId, cols, rows),
    kill: (sessionId) => ipcRenderer.invoke('pty:kill', sessionId),
    exists: (sessionId) => ipcRenderer.invoke('pty:exists', sessionId),
    getBuffer: (sessionId) => ipcRenderer.invoke('pty:getBuffer', sessionId),
    clearBuffer: (sessionId) => ipcRenderer.invoke('pty:clearBuffer', sessionId),
    getBufferSince: (sessionId, afterSeq) => ipcRenderer.invoke('pty:getBufferSince', sessionId, afterSeq),
    list: () => ipcRenderer.invoke('pty:list'),
    dismissAllNotifications: () => ipcRenderer.invoke('pty:dismissAllNotifications'),
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
    onSessionNotFound: (callback: (sessionId: string) => void) => {
      const handler = (_event: unknown, sessionId: string) => callback(sessionId)
      ipcRenderer.on('pty:session-not-found', handler)
      return () => ipcRenderer.removeListener('pty:session-not-found', handler)
    },
    onAttention: (callback: (sessionId: string) => void) => {
      const handler = (_event: unknown, sessionId: string) => callback(sessionId)
      ipcRenderer.on('pty:attention', handler)
      return () => ipcRenderer.removeListener('pty:attention', handler)
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
    onStats: (cb) => {
      const handler = (_event: unknown, stats: Record<string, import('@slayzone/types').ProcessStats>) => cb(stats)
      ipcRenderer.on('pty:stats', handler)
      return () => ipcRenderer.removeListener('pty:stats', handler)
    },
    getState: (sessionId: string) => ipcRenderer.invoke('pty:getState', sessionId),
    validate: (mode: string) => ipcRenderer.invoke('pty:validate', mode)
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
  git: {
    isGitRepo: (path) => ipcRenderer.invoke('git:isGitRepo', path),
    detectChildRepos: (projectPath) => ipcRenderer.invoke('git:detectChildRepos', projectPath),
    detectWorktrees: (repoPath) => ipcRenderer.invoke('git:detectWorktrees', repoPath),
    createWorktree: (opts) =>
      ipcRenderer.invoke('git:createWorktree', opts),
    removeWorktree: (repoPath, worktreePath, branchToDelete?) =>
      ipcRenderer.invoke('git:removeWorktree', repoPath, worktreePath, branchToDelete),
    init: (path) => ipcRenderer.invoke('git:init', path),
    getCurrentBranch: (path) => ipcRenderer.invoke('git:getCurrentBranch', path),
    listBranches: (path) => ipcRenderer.invoke('git:listBranches', path),
    checkoutBranch: (path, branch) => ipcRenderer.invoke('git:checkoutBranch', path, branch),
    createBranch: (path, branch) => ipcRenderer.invoke('git:createBranch', path, branch),
    hasUncommittedChanges: (path) => ipcRenderer.invoke('git:hasUncommittedChanges', path),
    mergeIntoParent: (projectPath, parentBranch, sourceBranch) =>
      ipcRenderer.invoke('git:mergeIntoParent', projectPath, parentBranch, sourceBranch),
    abortMerge: (path) => ipcRenderer.invoke('git:abortMerge', path),
    mergeWithAI: (projectPath, worktreePath, parentBranch, sourceBranch) =>
      ipcRenderer.invoke('git:mergeWithAI', projectPath, worktreePath, parentBranch, sourceBranch),
    isMergeInProgress: (path) => ipcRenderer.invoke('git:isMergeInProgress', path),
    getConflictedFiles: (path) => ipcRenderer.invoke('git:getConflictedFiles', path),
    getWorkingDiff: (path, opts?) => ipcRenderer.invoke('git:getWorkingDiff', path, opts),
    getFileDiff: (repoPath, filePath, staged, opts?) => ipcRenderer.invoke('git:getFileDiff', repoPath, filePath, staged, opts),
    stageFile: (path, filePath) => ipcRenderer.invoke('git:stageFile', path, filePath),
    unstageFile: (path, filePath) => ipcRenderer.invoke('git:unstageFile', path, filePath),
    discardFile: (path, filePath, untracked?) => ipcRenderer.invoke('git:discardFile', path, filePath, untracked),
    stageAll: (path) => ipcRenderer.invoke('git:stageAll', path),
    unstageAll: (path) => ipcRenderer.invoke('git:unstageAll', path),
    getUntrackedFileDiff: (repoPath, filePath) => ipcRenderer.invoke('git:getUntrackedFileDiff', repoPath, filePath),
    getConflictContent: (repoPath, filePath) => ipcRenderer.invoke('git:getConflictContent', repoPath, filePath),
    writeResolvedFile: (repoPath, filePath, content) => ipcRenderer.invoke('git:writeResolvedFile', repoPath, filePath, content),
    commitFiles: (repoPath, message) => ipcRenderer.invoke('git:commitFiles', repoPath, message),
    analyzeConflict: (mode, filePath, base, ours, theirs) =>
      ipcRenderer.invoke('git:analyzeConflict', mode, filePath, base, ours, theirs),
    isRebaseInProgress: (path) => ipcRenderer.invoke('git:isRebaseInProgress', path),
    getRebaseProgress: (repoPath) => ipcRenderer.invoke('git:getRebaseProgress', repoPath),
    abortRebase: (path) => ipcRenderer.invoke('git:abortRebase', path),
    continueRebase: (path) => ipcRenderer.invoke('git:continueRebase', path),
    skipRebaseCommit: (path) => ipcRenderer.invoke('git:skipRebaseCommit', path),
    getMergeContext: (repoPath) => ipcRenderer.invoke('git:getMergeContext', repoPath),
    getRecentCommits: (repoPath, count) => ipcRenderer.invoke('git:getRecentCommits', repoPath, count),
    getAheadBehind: (repoPath, branch, upstream) => ipcRenderer.invoke('git:getAheadBehind', repoPath, branch, upstream),
    getStatusSummary: (repoPath) => ipcRenderer.invoke('git:getStatusSummary', repoPath),
    revealInFinder: (path) => ipcRenderer.invoke('git:revealInFinder', path),
    isDirty: (path) => ipcRenderer.invoke('git:isDirty', path),
    getRemoteUrl: (path) => ipcRenderer.invoke('git:getRemoteUrl', path),
    getAheadBehindUpstream: (path, branch) => ipcRenderer.invoke('git:getAheadBehindUpstream', path, branch),
    fetch: (path) => ipcRenderer.invoke('git:fetch', path),
    push: (path, branch?, force?) => ipcRenderer.invoke('git:push', path, branch, force),
    pull: (path) => ipcRenderer.invoke('git:pull', path),
    getDefaultBranch: (path) => ipcRenderer.invoke('git:getDefaultBranch', path),
    listBranchesDetailed: (path) => ipcRenderer.invoke('git:listBranchesDetailed', path),
    listRemoteBranches: (path) => ipcRenderer.invoke('git:listRemoteBranches', path),
    getMergeBase: (path, branch1, branch2) => ipcRenderer.invoke('git:getMergeBase', path, branch1, branch2),
    getCommitsSince: (path, sinceRef, branch) => ipcRenderer.invoke('git:getCommitsSince', path, sinceRef, branch),
    getCommitsBeforeRef: (path, ref, count?) => ipcRenderer.invoke('git:getCommitsBeforeRef', path, ref, count),
    deleteBranch: (path, branch, force?) => ipcRenderer.invoke('git:deleteBranch', path, branch, force),
    pruneRemote: (path) => ipcRenderer.invoke('git:pruneRemote', path),
    rebaseOnto: (path, ontoBranch) => ipcRenderer.invoke('git:rebaseOnto', path, ontoBranch),
    mergeFrom: (path, branch) => ipcRenderer.invoke('git:mergeFrom', path, branch),
    getDiffStats: (path, ref) => ipcRenderer.invoke('git:getDiffStats', path, ref),
    getWorktreeMetadata: (path) => ipcRenderer.invoke('git:getWorktreeMetadata', path),
    getCommitDag: (path, limit, branches?) => ipcRenderer.invoke('git:getCommitDag', path, limit, branches),
    getResolvedCommitDag: (path, limit, branches, baseBranch) => ipcRenderer.invoke('git:getResolvedCommitDag', path, limit, branches, baseBranch),
    getResolvedForkGraph: (targetPath, repoPath, activeBranch, compareBranch, activeBranchLabel, compareBranchLabel) => ipcRenderer.invoke('git:getResolvedForkGraph', targetPath, repoPath, activeBranch, compareBranch, activeBranchLabel, compareBranchLabel),
    getResolvedUpstreamGraph: (repoPath, branch) => ipcRenderer.invoke('git:getResolvedUpstreamGraph', repoPath, branch),
    getResolvedRecentCommits: (path, count, branchName) => ipcRenderer.invoke('git:getResolvedRecentCommits', path, count, branchName),
    resolveChildBranches: (path, baseBranch) => ipcRenderer.invoke('git:resolveChildBranches', path, baseBranch),
    resolveCopyBehavior: (projectId?) => ipcRenderer.invoke('git:resolveCopyBehavior', projectId),
    getIgnoredFileTree: (repoPath) => ipcRenderer.invoke('git:getIgnoredFileTree', repoPath),
    copyIgnoredFiles: (repoPath, worktreePath, paths, mode?) => ipcRenderer.invoke('git:copyIgnoredFiles', repoPath, worktreePath, paths, mode),
    checkGhInstalled: () => ipcRenderer.invoke('git:checkGhInstalled'),
    hasGithubRemote: (repoPath) => ipcRenderer.invoke('git:hasGithubRemote', repoPath),
    listOpenPrs: (repoPath) => ipcRenderer.invoke('git:listOpenPrs', repoPath),
    getPrByUrl: (repoPath, url) => ipcRenderer.invoke('git:getPrByUrl', repoPath, url),
    createPr: (input) => ipcRenderer.invoke('git:createPr', input),
    getPrComments: (repoPath, prNumber) => ipcRenderer.invoke('git:getPrComments', repoPath, prNumber),
    addPrComment: (repoPath, prNumber, body) => ipcRenderer.invoke('git:addPrComment', repoPath, prNumber, body),
    mergePr: (input) => ipcRenderer.invoke('git:mergePr', input),
    getPrDiff: (repoPath, prNumber) => ipcRenderer.invoke('git:getPrDiff', repoPath, prNumber),
    getGhUser: (repoPath) => ipcRenderer.invoke('git:getGhUser', repoPath),
    editPrComment: (input) => ipcRenderer.invoke('git:editPrComment', input)
  },
  tabs: {
    list: (taskId) => ipcRenderer.invoke('tabs:list', taskId),
    create: (input) => ipcRenderer.invoke('tabs:create', input),
    update: (input) => ipcRenderer.invoke('tabs:update', input),
    delete: (tabId) => ipcRenderer.invoke('tabs:delete', tabId),
    ensureMain: (taskId, mode) => ipcRenderer.invoke('tabs:ensureMain', taskId, mode),
    split: (tabId) => ipcRenderer.invoke('tabs:split', tabId),
    moveToGroup: (tabId, targetGroupId) => ipcRenderer.invoke('tabs:moveToGroup', tabId, targetGroupId)
  },
  diagnostics: {
    getConfig: () => ipcRenderer.invoke('diagnostics:getConfig'),
    setConfig: (config) => ipcRenderer.invoke('diagnostics:setConfig', config),
    export: (request) => ipcRenderer.invoke('diagnostics:export', request),
    recordClientError: (input) => ipcRenderer.invoke('diagnostics:recordClientError', input),
    recordClientEvent: (input) => ipcRenderer.invoke('diagnostics:recordClientEvent', input)
  },
  telemetry: {
    onIpcEvent: (callback: (event: string, props: Record<string, unknown>) => void) => {
      const handler = (_: unknown, event: string, props: Record<string, unknown>) => callback(event, props)
      ipcRenderer.on('telemetry:ipc-event', handler)
      return () => ipcRenderer.removeListener('telemetry:ipc-event', handler)
    }
  },
  aiConfig: {
    listItems: (input) => ipcRenderer.invoke('ai-config:list-items', input),
    getItem: (id) => ipcRenderer.invoke('ai-config:get-item', id),
    createItem: (input) => ipcRenderer.invoke('ai-config:create-item', input),
    updateItem: (input) => ipcRenderer.invoke('ai-config:update-item', input),
    deleteItem: (id) => ipcRenderer.invoke('ai-config:delete-item', id),
    listProjectSelections: (projectId) => ipcRenderer.invoke('ai-config:list-project-selections', projectId),
    setProjectSelection: (input) => ipcRenderer.invoke('ai-config:set-project-selection', input),
    removeProjectSelection: (projectId, itemId, provider?) =>
      ipcRenderer.invoke('ai-config:remove-project-selection', projectId, itemId, provider),
    discoverContextFiles: (projectPath) => ipcRenderer.invoke('ai-config:discover-context-files', projectPath),
    readContextFile: (filePath, projectPath) => ipcRenderer.invoke('ai-config:read-context-file', filePath, projectPath),
    writeContextFile: (filePath, content, projectPath) =>
      ipcRenderer.invoke('ai-config:write-context-file', filePath, content, projectPath),
    getContextTree: (projectPath, projectId) =>
      ipcRenderer.invoke('ai-config:get-context-tree', projectPath, projectId),
    loadGlobalItem: (input) => ipcRenderer.invoke('ai-config:load-global-item', input),
    syncLinkedFile: (projectId, projectPath, itemId, provider?) =>
      ipcRenderer.invoke('ai-config:sync-linked-file', projectId, projectPath, itemId, provider),
    unlinkFile: (projectId, itemId) => ipcRenderer.invoke('ai-config:unlink-file', projectId, itemId),
    renameContextFile: (oldPath, newPath, projectPath) =>
      ipcRenderer.invoke('ai-config:rename-context-file', oldPath, newPath, projectPath),
    deleteContextFile: (filePath, projectPath, projectId) =>
      ipcRenderer.invoke('ai-config:delete-context-file', filePath, projectPath, projectId),
    deleteGlobalFile: (filePath) =>
      ipcRenderer.invoke('ai-config:delete-global-file', filePath),
    createGlobalFile: (provider, category, slug) =>
      ipcRenderer.invoke('ai-config:create-global-file', provider, category, slug),
    discoverMcpConfigs: (projectPath) =>
      ipcRenderer.invoke('ai-config:discover-mcp-configs', projectPath),
    writeMcpServer: (input) =>
      ipcRenderer.invoke('ai-config:write-mcp-server', input),
    removeMcpServer: (input) =>
      ipcRenderer.invoke('ai-config:remove-mcp-server', input),
    listProviders: () =>
      ipcRenderer.invoke('ai-config:list-providers'),
    toggleProvider: (id, enabled) =>
      ipcRenderer.invoke('ai-config:toggle-provider', id, enabled),
    getProjectProviders: (projectId) =>
      ipcRenderer.invoke('ai-config:get-project-providers', projectId),
    setProjectProviders: (projectId, providers) =>
      ipcRenderer.invoke('ai-config:set-project-providers', projectId, providers),
    needsSync: (projectId, projectPath) =>
      ipcRenderer.invoke('ai-config:needs-sync', projectId, projectPath),
    syncAll: (input) =>
      ipcRenderer.invoke('ai-config:sync-all', input),
    checkSyncStatus: (projectId, projectPath) =>
      ipcRenderer.invoke('ai-config:check-sync-status', projectId, projectPath),
    getGlobalInstructions: () =>
      ipcRenderer.invoke('ai-config:get-global-instructions'),
    saveGlobalInstructions: (content) =>
      ipcRenderer.invoke('ai-config:save-global-instructions', content),
    getRootInstructions: (projectId, projectPath) =>
      ipcRenderer.invoke('ai-config:get-root-instructions', projectId, projectPath),
    saveInstructionsContent: (projectId, projectPath, content) =>
      ipcRenderer.invoke('ai-config:save-instructions-content', projectId, projectPath, content),
    saveRootInstructions: (projectId, projectPath, content) =>
      ipcRenderer.invoke('ai-config:save-root-instructions', projectId, projectPath, content),
    readProviderInstructions: (projectPath, provider) =>
      ipcRenderer.invoke('ai-config:read-provider-instructions', projectPath, provider),
    pushProviderInstructions: (projectId, projectPath, provider, content) =>
      ipcRenderer.invoke('ai-config:push-provider-instructions', projectId, projectPath, provider, content),
    pullProviderInstructions: (projectId, projectPath, provider) =>
      ipcRenderer.invoke('ai-config:pull-provider-instructions', projectId, projectPath, provider),
    getProjectSkillsStatus: (projectId, projectPath) =>
      ipcRenderer.invoke('ai-config:get-project-skills-status', projectId, projectPath),
    readProviderSkill: (projectPath, provider, itemId) =>
      ipcRenderer.invoke('ai-config:read-provider-skill', projectPath, provider, itemId),
    getExpectedSkillContent: (projectPath, provider, itemId) =>
      ipcRenderer.invoke('ai-config:get-expected-skill-content', projectPath, provider, itemId),
    pullProviderSkill: (projectId, projectPath, provider, itemId) =>
      ipcRenderer.invoke('ai-config:pull-provider-skill', projectId, projectPath, provider, itemId),
    getGlobalFiles: () => ipcRenderer.invoke('ai-config:get-global-files')
  },
  fs: {
    readDir: (rootPath, dirPath) => ipcRenderer.invoke('fs:readDir', rootPath, dirPath),
    readFile: (rootPath, filePath, force) => ipcRenderer.invoke('fs:readFile', rootPath, filePath, force),
    writeFile: (rootPath, filePath, content) => ipcRenderer.invoke('fs:writeFile', rootPath, filePath, content),
    createFile: (rootPath, filePath) => ipcRenderer.invoke('fs:createFile', rootPath, filePath),
    createDir: (rootPath, dirPath) => ipcRenderer.invoke('fs:createDir', rootPath, dirPath),
    rename: (rootPath, oldPath, newPath) => ipcRenderer.invoke('fs:rename', rootPath, oldPath, newPath),
    delete: (rootPath, targetPath) => ipcRenderer.invoke('fs:delete', rootPath, targetPath),
    copyIn: (rootPath, absoluteSrc) => ipcRenderer.invoke('fs:copyIn', rootPath, absoluteSrc),
    listAllFiles: (rootPath) => ipcRenderer.invoke('fs:listAllFiles', rootPath),
    searchFiles: (rootPath, query, opts) => ipcRenderer.invoke('fs:searchFiles', rootPath, query, opts),
    watch: (rootPath) => ipcRenderer.invoke('fs:watch', rootPath),
    unwatch: (rootPath) => ipcRenderer.invoke('fs:unwatch', rootPath),
    onFileChanged: (callback) => {
      const handler = (_event: unknown, rootPath: string, relPath: string) => callback(rootPath, relPath)
      ipcRenderer.on('fs:changed', handler)
      return () => ipcRenderer.removeListener('fs:changed', handler)
    }
  },
  leaderboard: {
    getLocalStats: () => ipcRenderer.invoke('leaderboard:get-local-stats')
  },
  usage: {
    fetch: (force?: boolean) => ipcRenderer.invoke('usage:fetch', force),
    test: (config: any) => ipcRenderer.invoke('usage:test', config)
  },
  screenshot: {
    captureView: (viewId: string) => ipcRenderer.invoke('screenshot:captureView', viewId)
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
    registerBrowserPanel: (taskId, webContentsId) =>
      ipcRenderer.invoke('webview:register-browser-panel', taskId, webContentsId),
    unregisterBrowserPanel: (taskId) =>
      ipcRenderer.invoke('webview:unregister-browser-panel', taskId),
  },
  browser: {
    createView: (opts) => ipcRenderer.invoke('browser:create-view', opts),
    destroyView: (viewId) => ipcRenderer.invoke('browser:destroy-view', viewId),
    destroyAllForTask: (taskId) => ipcRenderer.invoke('browser:destroy-all-for-task', taskId),
    setBounds: (viewId, bounds) => ipcRenderer.invoke('browser:set-bounds', viewId, bounds),
    setVisible: (viewId, visible) => ipcRenderer.invoke('browser:set-visible', viewId, visible),
    hideAll: () => ipcRenderer.invoke('browser:hide-all'),
    showAll: () => ipcRenderer.invoke('browser:show-all'),
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
    getWebContentsId: (viewId) => ipcRenderer.invoke('browser:get-web-contents-id', viewId),
    setKeyboardPassthrough: (viewId, enabled) => ipcRenderer.invoke('browser:set-keyboard-passthrough', viewId, enabled),
    onBrowserViewShortcut: (cb) => {
      const handler = (_event: unknown, data: { viewId: string; key: string; shift: boolean; alt: boolean; meta: boolean; control: boolean }) => cb(data)
      ipcRenderer.on('browser-view:shortcut', handler)
      return () => ipcRenderer.removeListener('browser-view:shortcut', handler)
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
    onEvent: (cb) => {
      const handler = (_event: unknown, data: { viewId: string; type: string; [key: string]: unknown }) => cb(data)
      ipcRenderer.on('browser:event', handler)
      return () => ipcRenderer.removeListener('browser:event', handler)
    },
  },
  exportImport: {
    exportAll: () => ipcRenderer.invoke('export-import:export-all'),
    exportProject: (projectId) => ipcRenderer.invoke('export-import:export-project', projectId),
    import: () => ipcRenderer.invoke('export-import:import')
  },
  processes: {
    create: (projectId, taskId, label, command, cwd, autoRestart) =>
      ipcRenderer.invoke('processes:create', projectId, taskId, label, command, cwd, autoRestart),
    spawn: (projectId, taskId, label, command, cwd, autoRestart) =>
      ipcRenderer.invoke('processes:spawn', projectId, taskId, label, command, cwd, autoRestart),
    update: (processId, updates) => ipcRenderer.invoke('processes:update', processId, updates),
    stop: (processId) => ipcRenderer.invoke('processes:stop', processId),
    kill: (processId) => ipcRenderer.invoke('processes:kill', processId),
    restart: (processId) => ipcRenderer.invoke('processes:restart', processId),
    listForTask: (taskId, projectId) => ipcRenderer.invoke('processes:listForTask', taskId, projectId),
    listAll: () => ipcRenderer.invoke('processes:listAll'),
    killTask: (taskId) => ipcRenderer.invoke('processes:killTask', taskId),
    onLog: (cb) => {
      const handler = (_event: unknown, processId: string, line: string) => cb(processId, line)
      ipcRenderer.on('processes:log', handler)
      return () => ipcRenderer.removeListener('processes:log', handler)
    },
    onStatus: (cb) => {
      const handler = (_event: unknown, processId: string, status: import('@slayzone/types').ProcessStatus) => cb(processId, status)
      ipcRenderer.on('processes:status', handler)
      return () => ipcRenderer.removeListener('processes:status', handler)
    },
    onStats: (cb) => {
      const handler = (_event: unknown, stats: Record<string, import('@slayzone/types').ProcessStats>) => cb(stats)
      ipcRenderer.on('processes:stats', handler)
      return () => ipcRenderer.removeListener('processes:stats', handler)
    },
    onTitle: (cb) => {
      const handler = (_event: unknown, processId: string, title: string | null) => cb(processId, title)
      ipcRenderer.on('processes:title', handler)
      return () => ipcRenderer.removeListener('processes:title', handler)
    }
  },
  integrations: {
    connectGithub: (input) => ipcRenderer.invoke('integrations:connect-github', input),
    connectLinear: (input) => ipcRenderer.invoke('integrations:connect-linear', input),
    connectJira: (input) => ipcRenderer.invoke('integrations:connect-jira', input),
    getJiraTransitions: (taskId) => ipcRenderer.invoke('integrations:get-jira-transitions', taskId),
    updateConnection: (input) => ipcRenderer.invoke('integrations:update-connection', input),
    listConnections: (provider) => ipcRenderer.invoke('integrations:list-connections', provider),
    getConnectionUsage: (connectionId) => ipcRenderer.invoke('integrations:get-connection-usage', connectionId),
    disconnect: (connectionId) => ipcRenderer.invoke('integrations:disconnect', connectionId),
    clearProjectProvider: (input) => ipcRenderer.invoke('integrations:clear-project-provider', input),
    getProjectConnection: (projectId, provider) =>
      ipcRenderer.invoke('integrations:get-project-connection', projectId, provider),
    setProjectConnection: (input) => ipcRenderer.invoke('integrations:set-project-connection', input),
    clearProjectConnection: (input) => ipcRenderer.invoke('integrations:clear-project-connection', input),
    listGithubRepositories: (connectionId) =>
      ipcRenderer.invoke('integrations:list-github-repositories', connectionId),
    listGithubProjects: (connectionId) =>
      ipcRenderer.invoke('integrations:list-github-projects', connectionId),
    listGithubIssues: (input) => ipcRenderer.invoke('integrations:list-github-issues', input),
    importGithubIssues: (input) => ipcRenderer.invoke('integrations:import-github-issues', input),
    listGithubRepositoryIssues: (input) =>
      ipcRenderer.invoke('integrations:list-github-repository-issues', input),
    importGithubRepositoryIssues: (input) =>
      ipcRenderer.invoke('integrations:import-github-repository-issues', input),
    listLinearTeams: (connectionId) => ipcRenderer.invoke('integrations:list-linear-teams', connectionId),
    listLinearProjects: (connectionId, teamId) =>
      ipcRenderer.invoke('integrations:list-linear-projects', connectionId, teamId),
    listLinearIssues: (input) => ipcRenderer.invoke('integrations:list-linear-issues', input),
    setProjectMapping: (input) => ipcRenderer.invoke('integrations:set-project-mapping', input),
    getProjectMapping: (projectId, provider) =>
      ipcRenderer.invoke('integrations:get-project-mapping', projectId, provider),
    importLinearIssues: (input) => ipcRenderer.invoke('integrations:import-linear-issues', input),
    syncNow: (input) => ipcRenderer.invoke('integrations:sync-now', input),
    getTaskSyncStatus: (taskId, provider) => ipcRenderer.invoke('integrations:get-task-sync-status', taskId, provider),
    getBatchTaskSyncStatus: (taskIds, provider) => ipcRenderer.invoke('integrations:get-batch-task-sync-status', taskIds, provider),
    pushTask: (input) => ipcRenderer.invoke('integrations:push-task', input),
    pullTask: (input) => ipcRenderer.invoke('integrations:pull-task', input),
    getLink: (taskId, provider) => ipcRenderer.invoke('integrations:get-link', taskId, provider),
    unlinkTask: (taskId, provider) => ipcRenderer.invoke('integrations:unlink-task', taskId, provider),
    pushUnlinkedTasks: (input) => ipcRenderer.invoke('integrations:push-unlinked-tasks', input),
    fetchProviderStatuses: (input) => ipcRenderer.invoke('integrations:fetch-provider-statuses', input),
    applyStatusSync: (input) => ipcRenderer.invoke('integrations:apply-status-sync', input),
    resyncProviderStatuses: (input) => ipcRenderer.invoke('integrations:resync-provider-statuses', input),
    // Generic provider-dispatched
    listProviderGroups: (connectionId) => ipcRenderer.invoke('integrations:list-provider-groups', connectionId),
    listProviderScopes: (connectionId, groupId) => ipcRenderer.invoke('integrations:list-provider-scopes', connectionId, groupId),
    listProviderIssues: (input) => ipcRenderer.invoke('integrations:list-provider-issues', input),
    importProviderIssues: (input) => ipcRenderer.invoke('integrations:import-provider-issues', input)
  },
  backup: {
    list: () => ipcRenderer.invoke('backup:list'),
    create: (name?: string) => ipcRenderer.invoke('backup:create', name),
    rename: (filename: string, name: string) => ipcRenderer.invoke('backup:rename', filename, name),
    delete: (filename: string) => ipcRenderer.invoke('backup:delete', filename),
    restore: (filename: string) => ipcRenderer.invoke('backup:restore', filename),
    getSettings: () => ipcRenderer.invoke('backup:getSettings'),
    setSettings: (settings: Partial<import('@slayzone/types').BackupSettings>) => ipcRenderer.invoke('backup:setSettings', settings),
    revealInFinder: () => ipcRenderer.invoke('backup:revealInFinder')
  },
  testPanel: {
    getCategories: (projectId) => ipcRenderer.invoke('db:testPanel:getCategories', projectId),
    createCategory: (data) => ipcRenderer.invoke('db:testPanel:createCategory', data),
    updateCategory: (data) => ipcRenderer.invoke('db:testPanel:updateCategory', data),
    deleteCategory: (id) => ipcRenderer.invoke('db:testPanel:deleteCategory', id),
    reorderCategories: (ids) => ipcRenderer.invoke('db:testPanel:reorderCategories', ids),
    getProfiles: () => ipcRenderer.invoke('db:testPanel:getProfiles'),
    saveProfile: (profile) => ipcRenderer.invoke('db:testPanel:saveProfile', profile),
    deleteProfile: (id) => ipcRenderer.invoke('db:testPanel:deleteProfile', id),
    applyProfile: (projectId, profileId) => ipcRenderer.invoke('db:testPanel:applyProfile', projectId, profileId),
    scanFiles: (projectPath, projectId) => ipcRenderer.invoke('db:testPanel:scanFiles', projectPath, projectId),
    getLabels: (projectId) => ipcRenderer.invoke('db:testPanel:getLabels', projectId),
    createLabel: (data) => ipcRenderer.invoke('db:testPanel:createLabel', data),
    updateLabel: (data) => ipcRenderer.invoke('db:testPanel:updateLabel', data),
    deleteLabel: (id) => ipcRenderer.invoke('db:testPanel:deleteLabel', id),
    getFileLabels: (projectId) => ipcRenderer.invoke('db:testPanel:getFileLabels', projectId),
    toggleFileLabel: (projectId, filePath, labelId) => ipcRenderer.invoke('db:testPanel:toggleFileLabel', projectId, filePath, labelId),
    getFileNotes: (projectId) => ipcRenderer.invoke('db:testPanel:getFileNotes', projectId),
    setFileNote: (projectId, filePath, note) => ipcRenderer.invoke('db:testPanel:setFileNote', projectId, filePath, note)
  },

  usageAnalytics: {
    query: (range) => ipcRenderer.invoke('usage-analytics:query', range),
    refresh: (range) => ipcRenderer.invoke('usage-analytics:refresh', range),
    taskCost: (taskId) => ipcRenderer.invoke('usage-analytics:task-cost', taskId)
  }
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
    }
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.api = api
}
