import type { Task, MergeState } from '@slayzone/task/shared'
import type { FileDiff as FileDiffType } from './parse-diff'

export interface GitDiffPanelProps {
  task: Task | null
  projectPath: string | null
  visible: boolean
  pollIntervalMs?: number
  // Merge mode integration
  mergeState?: MergeState | null
  onCommitAndContinueMerge?: () => Promise<void>
  onAbortMerge?: () => void
}

export interface FileEntry {
  path: string
  status: 'M' | 'A' | 'D' | '?'
  source: 'unstaged' | 'staged'
}

export interface ConfirmAction {
  title: string
  description: string
  actionLabel: string
  destructive?: boolean
  onConfirm: () => Promise<void> | void
}

// Two virtual rows per file (header + body) so headers can be sticky via the
// tanstack-virtual sticky pattern. Collapsed files emit only a header row.
export type FlowRow =
  | { kind: 'header'; fileKey: string; fileIdx: number; entry: FileEntry; diff: FileDiffType }
  | { kind: 'body'; fileKey: string; fileIdx: number; entry: FileEntry; diff: FileDiffType }

export interface GitDiffPanelHandle {
  refresh: () => void
}
