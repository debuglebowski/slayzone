export interface DetectedWorktree {
  path: string
  branch: string | null
  isMain: boolean
  isDirty?: boolean
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

export interface GitSyncResult {
  success: boolean
  error?: string
}

// --- Pull Request (gh CLI) ---

export interface GhPullRequest {
  number: number
  title: string
  body: string
  url: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  headRefName: string
  baseRefName: string
  isDraft: boolean
  author: string
  createdAt: string
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | ''
  statusCheckRollup: 'SUCCESS' | 'FAILURE' | 'PENDING' | ''
}

export interface GhPrComment {
  id: string
  author: string
  body: string
  createdAt: string
  /** 'comment' = general PR comment, 'review' = review body */
  type: 'comment' | 'review'
  /** Only for review type */
  reviewState?: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED'
}

export interface CreatePrInput {
  repoPath: string
  title: string
  body: string
  baseBranch: string
  draft?: boolean
}

export interface CreatePrResult {
  url: string
  number: number
}

// --- Merge PR ---

export type MergeStrategy = 'merge' | 'squash' | 'rebase'

export interface MergePrInput {
  repoPath: string
  prNumber: number
  strategy: MergeStrategy
  deleteBranch?: boolean
  auto?: boolean
}

// --- Edit comment ---

export interface EditPrCommentInput {
  repoPath: string
  commentId: string
  body: string
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
