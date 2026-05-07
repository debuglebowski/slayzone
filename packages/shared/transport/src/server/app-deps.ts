// App-level dependencies that the router needs. The Electron-main host calls
// setAppDeps() at startup with concrete implementations; standalone server
// runs without these and procedures throw NOT_FOUND.

import type { BackupInfo, BackupSettings, LocalLeaderboardStats } from '@slayzone/types'
import type { ProviderUsage, UsageProviderConfig, UsageWindow } from '@slayzone/terminal/shared'

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
}

let appDeps: AppDeps | null = null

export function setAppDeps(deps: AppDeps): void {
  appDeps = deps
}

export function getAppDeps(): AppDeps {
  if (!appDeps) throw new Error('appDeps not initialized — call setAppDeps() in main host first')
  return appDeps
}
