import type { GitTabId } from '@slayzone/task/shared'

export interface UnifiedGitPanelHandle {
  switchToTab: (tab: GitTabId) => void
  getActiveTab: () => GitTabId
}

export interface ConflictToolbarData {
  resolvedCount: number
  totalCount: number
  isRebase: boolean
  onSkipCommit: () => void
  onAbort: () => void
}
