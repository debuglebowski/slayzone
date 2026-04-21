export interface CreateWorktreeOpts {
  repoPath: string
  targetPath: string
  branch?: string
  sourceBranch?: string
  projectId?: string
  /** Correlation id for phase progress events. Omit → no progress emitted. */
  requestId?: string
}

export interface WorktreeSubmoduleResult {
  ran: boolean
  success?: boolean
  output?: string
  reason?: 'no-gitmodules' | 'skipped' | 'failed' | 'timeout'
}

export interface CreateWorktreeResult {
  setupResult: { ran: boolean; success?: boolean; output?: string }
  submoduleResult: WorktreeSubmoduleResult
}

export type CreateWorktreePhase = 'creating' | 'copying' | 'submodules' | 'setup' | 'done'

export interface CreateWorktreePhaseEvent {
  requestId: string
  phase: CreateWorktreePhase
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

// --- Copy presets ---

export interface WorktreeCopyPreset {
  id: string
  name: string
  pathGlobs: string[]  // empty = all ignored files
}

export const DEFAULT_COPY_PRESETS: WorktreeCopyPreset[] = [
  { id: 'all-ignored', name: 'All ignored files', pathGlobs: [] },
  { id: 'env-only', name: 'Env files only', pathGlobs: ['.env*', '*.local'] },
  { id: 'docs-and-env', name: 'Docs + env', pathGlobs: ['docs/**', '*.md', '.env*', '*.local'] },
]

export interface DetectedWorktree {
  path: string
  branch: string | null
  isMain: boolean
  isDirty?: boolean
  color?: string
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
  /** Show branches forked from or behind base branch */
  showBranches: boolean
  /** Collapsed only: break collapse groups at tagged commits */
  breakOnTags: boolean
  /** Collapsed only: break collapse groups at merged PR commits */
  breakOnMerges: boolean
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

// --- Stash ---

export interface StashEntry {
  /** 0-based index, matches `stash@{N}` */
  index: number
  /** Short SHA of the stash commit */
  sha: string
  /** Reflog-style message (e.g. "WIP on main: 1a2b3c Some commit") */
  rawMessage: string
  /** User-provided or auto-generated label */
  message: string
  /** Branch the stash was created on */
  branch: string
  /** Unix timestamp (seconds) */
  createdAt: number
  filesChanged: number
  insertions: number
  deletions: number
  includesUntracked: boolean
}

export interface StashApplyResult {
  success: boolean
  conflicted: boolean
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
