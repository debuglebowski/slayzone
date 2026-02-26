export interface WorktreeCopyEntry {
  /** Path relative to repo root (e.g. '.env', 'node_modules') */
  path: string
  /** Whether to copy the file/dir or create a symlink */
  mode: 'copy' | 'symlink'
}

export interface DetectedWorktree {
  path: string
  branch: string | null
  isMain: boolean
}

export interface MergeResult {
  success: boolean
  merged: boolean
  conflicted: boolean
  error?: string
}

export interface MergeWithAIResult {
  success?: boolean
  resolving?: boolean
  sessionId?: string
  conflictedFiles?: string[]
  prompt?: string
  error?: string
}

export interface ConflictFileContent {
  path: string
  base: string | null
  ours: string | null
  theirs: string | null
  merged: string | null
}

export interface ConflictAnalysis {
  summary: string
  suggestion: string
}

// --- Rebase / merge context ---

export interface RebaseProgress {
  current: number // 1-based index of current commit
  total: number
  commits: RebaseCommitInfo[]
}

export interface RebaseCommitInfo {
  hash: string
  shortHash: string
  message: string
  status: 'applied' | 'current' | 'pending'
}

// --- General tab data ---

export interface CommitInfo {
  hash: string
  shortHash: string
  message: string
  author: string
  relativeDate: string
}

export interface AheadBehind {
  ahead: number
  behind: number
}

export interface StatusSummary {
  staged: number
  unstaged: number
  untracked: number
}

export interface GitDiffSnapshot {
  targetPath: string
  files: string[]
  stagedFiles: string[]
  unstagedFiles: string[]
  untrackedFiles: string[]
  unstagedPatch: string
  stagedPatch: string
  generatedAt: string
  isGitRepo: boolean
}
