// cap-migrate-all-tests (git batch) — window.api.git shim.
//
// Every method is a thin wrapper over `jsonRpcCall('git:<method>', …)` —
// the sidecar-side worktrees-bridge registers the real handlers from
// `@slayzone/worktrees/main` against the Chromium build's JSON-RPC surface.
//
// Deliberate shape: args land as positional params (the dispatcher unwraps
// `{params: [...]}` envelopes — see packages/sidecar/src/dispatcher/registry.ts
// normalizeParams). Return values pass through untouched.
//
// Not wired here (stub-factory still handles these if any caller surfaces):
//   • event subscriptions (git has none)
//   • binary streams (git has none)

import { jsonRpcCall } from '../transport/mojo'

function call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
  return jsonRpcCall<T>(`git:${method}`, { params: args })
}

async function callVoid(method: string, ...args: unknown[]): Promise<void> {
  await jsonRpcCall(`git:${method}`, { params: args })
}

export const gitShim = {
  isGitRepo: (p: string) => call<boolean>('isGitRepo', p),
  detectChildRepos: (projectPath: string) =>
    call<{ name: string; path: string }[]>('detectChildRepos', projectPath),
  detectWorktrees: (repoPath: string) => call('detectWorktrees', repoPath),
  createWorktree: (opts: {
    repoPath: string
    targetPath: string
    branch: string
    sourceBranch?: string
    projectId?: string
  }) => call<{ setupResult: unknown }>('createWorktree', opts),
  removeWorktree: (repoPath: string, worktreePath: string, branchHint?: string) =>
    call<{ branchDeleted?: boolean; branchError?: string }>(
      'removeWorktree',
      repoPath,
      worktreePath,
      branchHint,
    ),

  init: (path: string) => callVoid('init', path),
  getCurrentBranch: (path: string) => call<string | null>('getCurrentBranch', path),
  listBranches: (path: string) => call<string[]>('listBranches', path),
  checkoutBranch: (path: string, branch: string) => callVoid('checkoutBranch', path, branch),
  createBranch: (path: string, branch: string) => callVoid('createBranch', path, branch),
  hasUncommittedChanges: (path: string) => call<boolean>('hasUncommittedChanges', path),
  mergeIntoParent: (projectPath: string, parentBranch: string, sourceBranch: string) =>
    call('mergeIntoParent', projectPath, parentBranch, sourceBranch),
  abortMerge: (path: string) => callVoid('abortMerge', path),
  mergeWithAI: (
    projectPath: string,
    worktreePath: string,
    parentBranch: string,
    sourceBranch: string,
  ) =>
    call<{
      success?: boolean
      resolving?: boolean
      conflictedFiles?: string[]
      prompt?: string
      error?: string
    }>('mergeWithAI', projectPath, worktreePath, parentBranch, sourceBranch),
  isMergeInProgress: (path: string) => call<boolean>('isMergeInProgress', path),
  getConflictedFiles: (path: string) => call<string[]>('getConflictedFiles', path),
  getWorkingDiff: (
    path: string,
    opts?: { contextLines?: string; ignoreWhitespace?: boolean },
  ) => call('getWorkingDiff', path, opts),
  stageFile: (path: string, filePath: string) => callVoid('stageFile', path, filePath),
  unstageFile: (path: string, filePath: string) => callVoid('unstageFile', path, filePath),
  discardFile: (path: string, filePath: string, untracked?: boolean) =>
    callVoid('discardFile', path, filePath, untracked),
  stageAll: (path: string) => callVoid('stageAll', path),
  unstageAll: (path: string) => callVoid('unstageAll', path),
  getFileDiff: (
    repoPath: string,
    filePath: string,
    staged: boolean,
    opts?: { contextLines?: string; ignoreWhitespace?: boolean },
  ) => call<string>('getFileDiff', repoPath, filePath, staged, opts),
  getUntrackedFileDiff: (repoPath: string, filePath: string) =>
    call<string>('getUntrackedFileDiff', repoPath, filePath),
  getConflictContent: (repoPath: string, filePath: string) =>
    call<{
      path: string
      ours: string | null
      theirs: string | null
      base: string | null
      merged: string
    }>('getConflictContent', repoPath, filePath),
  writeResolvedFile: (repoPath: string, filePath: string, content: string) =>
    callVoid('writeResolvedFile', repoPath, filePath, content),
  commitFiles: (repoPath: string, message: string) => callVoid('commitFiles', repoPath, message),
  analyzeConflict: (
    mode: string,
    filePath: string,
    base: string | null,
    ours: string | null,
    theirs: string | null,
  ) => call('analyzeConflict', mode, filePath, base, ours, theirs),

  // Rebase
  isRebaseInProgress: (path: string) => call<boolean>('isRebaseInProgress', path),
  getRebaseProgress: (repoPath: string) => call('getRebaseProgress', repoPath),
  abortRebase: (path: string) => callVoid('abortRebase', path),
  continueRebase: (path: string) => call('continueRebase', path),
  skipRebaseCommit: (path: string) => call('skipRebaseCommit', path),

  // Context + diagnostics
  getMergeContext: (repoPath: string) => call('getMergeContext', repoPath),
  getRecentCommits: (repoPath: string, count?: number) =>
    call('getRecentCommits', repoPath, count),
  getAheadBehind: (repoPath: string, branch: string, upstream: string) =>
    call('getAheadBehind', repoPath, branch, upstream),
  getStatusSummary: (repoPath: string) => call('getStatusSummary', repoPath),
  revealInFinder: (path: string) => callVoid('revealInFinder', path),
  isDirty: (path: string) => call<boolean>('isDirty', path),
  getRemoteUrl: (path: string) => call<string | null>('getRemoteUrl', path),
  getAheadBehindUpstream: (path: string, branch: string) =>
    call('getAheadBehindUpstream', path, branch),
  fetch: (path: string) => callVoid('fetch', path),
  push: (path: string, branch?: string, force?: boolean) => call('push', path, branch, force),
  pull: (path: string) => call('pull', path),

  // Branch tab
  getDefaultBranch: (path: string) => call<string>('getDefaultBranch', path),
  listBranchesDetailed: (path: string) => call('listBranchesDetailed', path),
  listRemoteBranches: (path: string) => call<string[]>('listRemoteBranches', path),
  getMergeBase: (path: string, branch1: string, branch2: string) =>
    call<string | null>('getMergeBase', path, branch1, branch2),
  getCommitsSince: (path: string, sinceRef: string, branch: string) =>
    call('getCommitsSince', path, sinceRef, branch),
  getCommitsBeforeRef: (path: string, ref: string, count?: number) =>
    call('getCommitsBeforeRef', path, ref, count),
  deleteBranch: (path: string, branch: string, force?: boolean) =>
    call('deleteBranch', path, branch, force),
  pruneRemote: (path: string) => call('pruneRemote', path),

  // Worktree tab
  rebaseOnto: (path: string, ontoBranch: string) => call('rebaseOnto', path, ontoBranch),
  mergeFrom: (path: string, branch: string) => call('mergeFrom', path, branch),
  getDiffStats: (path: string, ref: string) => call('getDiffStats', path, ref),
  getWorktreeMetadata: (path: string) => call('getWorktreeMetadata', path),

  // DAG
  getCommitDag: (path: string, limit: number, branches?: string[]) =>
    call('getCommitDag', path, limit, branches),
  getResolvedCommitDag: (
    path: string,
    limit: number,
    branches: string[] | undefined,
    baseBranch: string,
  ) => call('getResolvedCommitDag', path, limit, branches, baseBranch),
  getResolvedForkGraph: (
    targetPath: string,
    repoPath: string,
    activeBranch: string,
    compareBranch: string,
    activeBranchLabel: string,
    compareBranchLabel: string,
  ) =>
    call(
      'getResolvedForkGraph',
      targetPath,
      repoPath,
      activeBranch,
      compareBranch,
      activeBranchLabel,
      compareBranchLabel,
    ),
  getResolvedUpstreamGraph: (repoPath: string, branch: string) =>
    call('getResolvedUpstreamGraph', repoPath, branch),
  getResolvedRecentCommits: (path: string, count: number, branchName: string) =>
    call('getResolvedRecentCommits', path, count, branchName),
  resolveChildBranches: (path: string, baseBranch: string) =>
    call('resolveChildBranches', path, baseBranch),
  resolveCopyBehavior: (projectId?: string) => call('resolveCopyBehavior', projectId),
  getIgnoredFileTree: (repoPath: string) => call('getIgnoredFileTree', repoPath),
  copyIgnoredFiles: (
    repoPath: string,
    worktreePath: string,
    paths: string[],
    mode?: 'all' | 'custom',
  ) => callVoid('copyIgnoredFiles', repoPath, worktreePath, paths, mode),

  // GitHub CLI
  checkGhInstalled: () => call<boolean>('checkGhInstalled'),
  hasGithubRemote: (repoPath: string) => call<boolean>('hasGithubRemote', repoPath),
  listOpenPrs: (repoPath: string) => call('listOpenPrs', repoPath),
  getPrByUrl: (repoPath: string, url: string) => call('getPrByUrl', repoPath, url),
  createPr: (input: unknown) => call('createPr', input),
  getPrComments: (repoPath: string, prNumber: number) =>
    call('getPrComments', repoPath, prNumber),
  addPrComment: (repoPath: string, prNumber: number, body: string) =>
    callVoid('addPrComment', repoPath, prNumber, body),
  mergePr: (input: unknown) => callVoid('mergePr', input),
  getPrDiff: (repoPath: string, prNumber: number) => call('getPrDiff', repoPath, prNumber),
  getGhUser: (repoPath: string) => call<string>('getGhUser', repoPath),
  editPrComment: (input: unknown) => callVoid('editPrComment', input),

  // Stash
  listStashes: (repoPath: string) => call('listStashes', repoPath),
  createStash: (
    repoPath: string,
    message: string,
    includeUntracked: boolean,
    keepIndex: boolean,
  ) => call('createStash', repoPath, message, includeUntracked, keepIndex),
  applyStash: (repoPath: string, index: number) => call('applyStash', repoPath, index),
  popStash: (repoPath: string, index: number) => call('popStash', repoPath, index),
  dropStash: (repoPath: string, index: number) => call('dropStash', repoPath, index),
  branchFromStash: (repoPath: string, index: number, branchName: string) =>
    call('branchFromStash', repoPath, index, branchName),
  getStashDiff: (repoPath: string, index: number) => call('getStashDiff', repoPath, index),
}
