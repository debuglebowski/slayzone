/**
 * `@slayzone/worktrees/git-ops`: the git panel's operations as ONE table keyed like
 * `gitOpsContract`. The hub's router runs it in-process (the local fallback) and the
 * computer's `git.op` handler runs the same table on its own disk — one
 * implementation, never a computer-side copy that drifts.
 *
 * Lean by contract (asserted in git-ops.test.ts): git, fs and the injected exec
 * environment only — no DB, Electron, React or tRPC.
 */
import { gitOpsContract, type GitOpInput, type GitOpName } from '../shared/git-ops-contract'
import * as git from './git-worktree'

type Opts = Parameters<typeof git.getWorkingDiff>[1]
type FileDiffOpts = Parameters<typeof git.getFileDiff>[3]

export const gitOpImpls = {
  isGitRepo: (i: GitOpInput<'isGitRepo'>) => git.isGitRepo(i.path),
  init: (i: GitOpInput<'init'>) => git.initRepo(i.path),
  getCurrentBranch: (i: GitOpInput<'getCurrentBranch'>) => git.getCurrentBranch(i.path),
  listBranches: (i: GitOpInput<'listBranches'>) => git.listBranches(i.path),
  checkoutBranch: (i: GitOpInput<'checkoutBranch'>) => git.checkoutBranch(i.path, i.branch),
  createBranch: (i: GitOpInput<'createBranch'>) => git.createBranch(i.path, i.branch),
  hasUncommittedChanges: (i: GitOpInput<'hasUncommittedChanges'>) =>
    git.hasUncommittedChanges(i.path),
  mergeIntoParent: (i: GitOpInput<'mergeIntoParent'>) =>
    git.mergeIntoParent(i.projectPath, i.parentBranch, i.sourceBranch),
  abortMerge: (i: GitOpInput<'abortMerge'>) => git.abortMerge(i.path),
  isMergeInProgress: (i: GitOpInput<'isMergeInProgress'>) => git.isMergeInProgress(i.path),
  getConflictedFiles: (i: GitOpInput<'getConflictedFiles'>) => git.getConflictedFiles(i.path),
  getWorkingDiff: (i: GitOpInput<'getWorkingDiff'>) => git.getWorkingDiff(i.path, i.opts as Opts),
  stageFile: (i: GitOpInput<'stageFile'>) => git.stageFile(i.path, i.filePath),
  unstageFile: (i: GitOpInput<'unstageFile'>) => git.unstageFile(i.path, i.filePath),
  discardFile: (i: GitOpInput<'discardFile'>) => git.discardFile(i.path, i.filePath, i.untracked),
  stageAll: (i: GitOpInput<'stageAll'>) => git.stageAll(i.path),
  unstageAll: (i: GitOpInput<'unstageAll'>) => git.unstageAll(i.path),
  getFileDiff: (i: GitOpInput<'getFileDiff'>) =>
    git.getFileDiff(i.repoPath, i.filePath, i.staged, i.opts as FileDiffOpts),
  getUntrackedFileDiff: (i: GitOpInput<'getUntrackedFileDiff'>) =>
    git.getUntrackedFileDiff(i.repoPath, i.filePath),
  getUntrackedFileDiffs: (i: GitOpInput<'getUntrackedFileDiffs'>) =>
    git.getUntrackedFileDiffs(i.repoPath, i.filePaths),
  getConflictContent: (i: GitOpInput<'getConflictContent'>) =>
    git.getConflictContent(i.repoPath, i.filePath),
  writeResolvedFile: async (i: GitOpInput<'writeResolvedFile'>) =>
    git.writeResolvedFile(i.repoPath, i.filePath, i.content),
  commitFiles: (i: GitOpInput<'commitFiles'>) => git.commitFiles(i.repoPath, i.message),

  isRebaseInProgress: (i: GitOpInput<'isRebaseInProgress'>) => git.isRebaseInProgress(i.path),
  getRebaseProgress: (i: GitOpInput<'getRebaseProgress'>) => git.getRebaseProgress(i.repoPath),
  abortRebase: (i: GitOpInput<'abortRebase'>) => git.abortRebase(i.path),
  continueRebase: (i: GitOpInput<'continueRebase'>) => git.continueRebase(i.path),
  skipRebaseCommit: (i: GitOpInput<'skipRebaseCommit'>) => git.skipRebaseCommit(i.path),
  getMergeContext: (i: GitOpInput<'getMergeContext'>) => git.getMergeContext(i.repoPath),

  getRecentCommits: (i: GitOpInput<'getRecentCommits'>) =>
    git.getRecentCommits(i.repoPath, i.count),
  getAheadBehind: (i: GitOpInput<'getAheadBehind'>) =>
    git.getAheadBehind(i.repoPath, i.branch, i.upstream),
  getStatusSummary: (i: GitOpInput<'getStatusSummary'>) => git.getStatusSummary(i.repoPath),
  isDirty: async (i: GitOpInput<'isDirty'>) => {
    const summary = await git.getStatusSummary(i.path)
    return summary.staged + summary.unstaged + summary.untracked > 0
  },
  getRemoteUrl: (i: GitOpInput<'getRemoteUrl'>) => git.getRemoteUrl(i.path),
  getAheadBehindUpstream: (i: GitOpInput<'getAheadBehindUpstream'>) =>
    git.getAheadBehindUpstream(i.path, i.branch),
  fetch: (i: GitOpInput<'fetch'>) => git.gitFetch(i.path),
  push: (i: GitOpInput<'push'>) => git.gitPush(i.path, i.force),
  pull: (i: GitOpInput<'pull'>) => git.gitPull(i.path),

  getDefaultBranch: (i: GitOpInput<'getDefaultBranch'>) => git.getDefaultBranch(i.path),
  listBranchesDetailed: (i: GitOpInput<'listBranchesDetailed'>) => git.listBranchesDetailed(i.path),
  listRemoteBranches: (i: GitOpInput<'listRemoteBranches'>) => git.listRemoteBranches(i.path),
  getMergeBase: (i: GitOpInput<'getMergeBase'>) => git.getMergeBase(i.path, i.branch1, i.branch2),
  getCommitsSince: (i: GitOpInput<'getCommitsSince'>) =>
    git.getCommitsSince(i.path, i.sinceRef, i.branch),
  getCommitsBeforeRef: (i: GitOpInput<'getCommitsBeforeRef'>) =>
    git.getCommitsBeforeRef(i.path, i.ref, i.count),
  deleteBranch: (i: GitOpInput<'deleteBranch'>) => git.deleteBranch(i.path, i.branch, i.force),
  pruneRemote: (i: GitOpInput<'pruneRemote'>) => git.pruneRemote(i.path),

  rebaseOnto: (i: GitOpInput<'rebaseOnto'>) => git.rebaseOnto(i.path, i.ontoBranch),
  mergeFrom: (i: GitOpInput<'mergeFrom'>) => git.mergeFrom(i.path, i.branch),
  getDiffStats: (i: GitOpInput<'getDiffStats'>) => git.getDiffStats(i.path, i.ref),
  getWorktreeMetadata: (i: GitOpInput<'getWorktreeMetadata'>) => git.getWorktreeMetadata(i.path),
  getCommitDag: (i: GitOpInput<'getCommitDag'>) => git.getCommitDag(i.path, i.limit, i.branches),
  resolveChildBranches: (i: GitOpInput<'resolveChildBranches'>) =>
    git.resolveChildBranches(i.path, i.baseBranch),
  getIgnoredFileTree: (i: GitOpInput<'getIgnoredFileTree'>) => git.getIgnoredFileTree(i.repoPath),
  copyIgnoredFiles: (i: GitOpInput<'copyIgnoredFiles'>) =>
    git.copyIgnoredFiles(
      i.repoPath,
      i.worktreePath,
      i.mode ?? (i.paths.length > 0 ? 'custom' : 'all'),
      i.paths
    ),

  getResolvedCommitDag: (i: GitOpInput<'getResolvedCommitDag'>) =>
    git.getResolvedCommitDag(i.path, i.limit, i.branches, i.baseBranch),
  getResolvedForkGraph: (i: GitOpInput<'getResolvedForkGraph'>) =>
    git.getResolvedForkGraph(
      i.targetPath,
      i.repoPath,
      i.activeBranch,
      i.compareBranch,
      i.activeBranchLabel,
      i.compareBranchLabel
    ),
  getResolvedUpstreamGraph: (i: GitOpInput<'getResolvedUpstreamGraph'>) =>
    git.getResolvedUpstreamGraph(i.repoPath, i.branch),
  getResolvedRecentCommits: (i: GitOpInput<'getResolvedRecentCommits'>) =>
    git.getResolvedRecentCommits(i.path, i.count, i.branchName),

  listStashes: (i: GitOpInput<'listStashes'>) => git.listStashes(i.repoPath),
  createStash: (i: GitOpInput<'createStash'>) =>
    git.createStash(i.repoPath, i.message, i.includeUntracked, i.keepIndex),
  applyStash: (i: GitOpInput<'applyStash'>) => git.applyStash(i.repoPath, i.index),
  popStash: (i: GitOpInput<'popStash'>) => git.popStash(i.repoPath, i.index),
  dropStash: (i: GitOpInput<'dropStash'>) => git.dropStash(i.repoPath, i.index),
  branchFromStash: (i: GitOpInput<'branchFromStash'>) =>
    git.branchFromStash(i.repoPath, i.index, i.branchName),
  getStashDiff: (i: GitOpInput<'getStashDiff'>) => git.getStashDiff(i.repoPath, i.index)
} satisfies { [K in GitOpName]: (input: GitOpInput<K>) => Promise<unknown> }

export type GitOpResult<K extends GitOpName> = Awaited<ReturnType<(typeof gitOpImpls)[K]>>

/** Run one op on THIS machine, its input validated against the contract first. */
export function runGitOpLocally<K extends GitOpName>(
  op: K,
  input: GitOpInput<K>
): Promise<GitOpResult<K>> {
  const parsed = gitOpsContract[op].input.parse(input) as GitOpInput<K>
  return (gitOpImpls[op] as unknown as (i: GitOpInput<K>) => Promise<GitOpResult<K>>)(parsed)
}

export {
  gitOpsContract,
  gitOpAbsolutePaths,
  gitOpRepoRelativePaths,
  isGitOpName,
  type GitOpInput,
  type GitOpName
} from '../shared/git-ops-contract'
export { configureGitExec, type GitExecEnvironment } from './exec-async'
export { createGitWatcher, type GitWatcher, type GitDiffChangedPayload } from './git-watcher'
