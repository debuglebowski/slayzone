export interface CreateWorktreeOpts {
  repoPath: string
  targetPath: string
  branch?: string
  sourceBranch?: string
  projectId?: string
}

export interface IgnoredFileNode {
  name: string
  path: string
  isDirectory: boolean
  /** Byte size (files only, 0 for dirs) */
  size: number
  /** Number of descendant files */
  fileCount: number
  children: IgnoredFileNode[]
}

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
  /** Files commented on in this review */
  reviewFiles?: string[]
}

export interface GhPrCommit {
  type: 'commit'
  oid: string
  messageHeadline: string
  author: string
  createdAt: string
}

export type GhPrTimelineEvent = GhPrComment | GhPrCommit

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

// --- Branch tab data ---

export interface BranchDetail {
  name: string
  lastCommit: CommitInfo
  upstream: string | null
  aheadBehindUpstream: AheadBehind | null
  aheadBehindDefault: AheadBehind | null
  isDefault: boolean
  isCurrent: boolean
}

export interface BranchListResult {
  branches: BranchDetail[]
  defaultBranch: string
}

export interface DeleteBranchResult {
  success: boolean
  error?: string
}

export interface PruneResult {
  pruned: string[]
}

export interface DiffStatsSummary {
  filesChanged: number
  insertions: number
  deletions: number
}

export interface WorktreeMetadata {
  path: string
  diskSize: string
  createdAt: string | null
}

// --- Commit graph config ---

export interface CommitGraphConfig {
  /** Branch shown as the left/base column (resolved at runtime, not user-editable) */
  baseBranch: string
  /** Show individual commits vs collapsed summaries */
  collapsed: boolean
  /** Show child branches of base branch */
  includeChildBranches: boolean
  /** Show merged/deleted PR branches */
  includeDeletedBranches: boolean
  /** Collapsed only: break collapse chain at tagged commits */
  includeTags: boolean
}

// --- DAG graph data ---

export interface DagCommit {
  hash: string
  shortHash: string
  message: string
  author: string
  relativeDate: string
  parents: string[]
  refs: string[]
}

// --- Resolved graph data (git-ref semantics pre-resolved) ---

export interface ResolvedCommit {
  hash: string
  shortHash: string
  message: string
  author: string
  relativeDate: string
  parents: string[]
  /** Owning branch name, already resolved (no "origin/", "HEAD ->") */
  branch: string
  /** Display labels pointing at this commit (e.g. ["main"]) */
  branchRefs: string[]
  tags: string[]
  isBranchTip: boolean
  isHead: boolean
  /** Branch name this commit came from, extracted from merge commit message (deleted PR branches) */
  mergedFrom?: string
}

export interface ResolvedGraph {
  commits: ResolvedCommit[]
  /** Branch that gets base color */
  baseBranch: string
  /** All branch names present, ordered by priority */
  branches: string[]
}

export interface ForkGraphResult {
  graph: ResolvedGraph
  forkPoint: string
  /** Number of commits on the active (feature) branch since fork */
  featureCount: number
  /** Number of commits on the compare (base) branch since fork */
  baseCount: number
}

export interface RebaseOntoResult {
  success: boolean
  conflicted?: boolean
  error?: string
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
