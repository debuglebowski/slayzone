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
