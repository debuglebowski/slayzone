import { z } from 'zod'
import { observable } from '@trpc/server/observable'
import {
  isGitRepo,
  removeWorktree,
  initRepo,
  getCurrentBranch,
  listBranches,
  checkoutBranch,
  createBranch,
  hasUncommittedChanges,
  mergeIntoParent,
  abortMerge,
  isMergeInProgress,
  getConflictedFiles,
  getConflictContent,
  writeResolvedFile,
  commitFiles,
  getWorkingDiff,
  stageFile,
  unstageFile,
  discardFile,
  stageAll,
  unstageAll,
  getFileDiff,
  getUntrackedFileDiff,
  isRebaseInProgress,
  getRebaseProgress,
  abortRebase,
  continueRebase,
  skipRebaseCommit,
  getMergeContext,
  getRecentCommits,
  getAheadBehind,
  getAheadBehindUpstream,
  getStatusSummary,
  getRemoteUrl,
  gitFetch,
  gitPush,
  gitPull,
  getDefaultBranch,
  listBranchesDetailed,
  listRemoteBranches,
  getMergeBase,
  getCommitsSince,
  getCommitsBeforeRef,
  deleteBranch,
  pruneRemote,
  rebaseOnto,
  mergeFrom,
  getDiffStats,
  getWorktreeMetadata,
  getCommitDag,
  resolveChildBranches,
  copyIgnoredFiles,
  getIgnoredFileTree,
  getResolvedCommitDag,
  getResolvedForkGraph,
  getResolvedUpstreamGraph,
  getResolvedRecentCommits,
  listStashes,
  createStash,
  applyStash,
  popStash,
  dropStash,
  branchFromStash,
  getStashDiff,
  resolveCopyBehavior,
  detectChildRepos,
  detectWorktreesWithColors,
  createWorktreeWithSetup,
  mergeWithAI,
  analyzeConflict,
  listProjectRepos,
  getGitWatcher,
  checkGhInstalled,
  hasGithubRemote,
  listOpenPrs,
  getPrByUrl,
  createPr,
  getPrComments,
  addPrComment,
  mergePr,
  getPrDiff,
  getGhUser,
  editPrComment,
  worktreesEvents
} from '@slayzone/worktrees/server'
import type {
  CreateWorktreeOpts,
  CreateWorktreePhase,
  CreateWorktreePhaseEvent,
  CreatePrInput,
  MergePrInput,
  EditPrCommentInput
} from '@slayzone/worktrees/shared'
import { router, publicProcedure } from '../trpc'

const u = z.unknown()
const s = z.string()
const sn = z.string().nullable()
const obj = z.object

export const worktreesRouter = router({
  // Watch / unwatch (refcounted)
  watchStart: publicProcedure.input(obj({ worktreePath: s })).mutation(({ input }) => {
    getGitWatcher().subscribe(input.worktreePath)
  }),
  watchStop: publicProcedure.input(obj({ worktreePath: s })).mutation(({ input }) => {
    getGitWatcher().unsubscribe(input.worktreePath)
  }),

  isGitRepo: publicProcedure.input(obj({ path: s })).query(({ input }) => isGitRepo(input.path)),
  listProjectRepos: publicProcedure
    .input(obj({ projectPath: s, opts: u.optional() }))
    .query(({ input }) => listProjectRepos(input.projectPath, (input.opts ?? {}) as never)),
  detectChildRepos: publicProcedure
    .input(obj({ projectPath: s }))
    .query(({ input }) => detectChildRepos(input.projectPath)),
  detectWorktrees: publicProcedure
    .input(obj({ repoPath: s }))
    .query(({ input }) => detectWorktreesWithColors(input.repoPath)),
  createWorktree: publicProcedure.input(u).mutation(({ ctx, input }) => {
    const opts = input as CreateWorktreeOpts
    const { requestId } = opts
    const onPhase = requestId
      ? (phase: CreateWorktreePhase): void => {
          worktreesEvents.emit('createWorktree:phase', { requestId, phase })
        }
      : undefined
    return createWorktreeWithSetup(ctx.db, opts, onPhase)
  }),
  /** Phase progress for one createWorktree call, correlated by its requestId. */
  onCreateWorktreePhase: publicProcedure.input(obj({ requestId: s })).subscription(({ input }) =>
    observable<CreateWorktreePhaseEvent>((emit) => {
      const handler = (event: CreateWorktreePhaseEvent): void => {
        if (event.requestId === input.requestId) emit.next(event)
      }
      worktreesEvents.on('createWorktree:phase', handler)
      return () => {
        worktreesEvents.off('createWorktree:phase', handler)
      }
    })
  ),
  removeWorktree: publicProcedure
    .input(obj({ repoPath: s, worktreePath: s, branchHint: s.optional() }))
    .mutation(({ input }) => removeWorktree(input.repoPath, input.worktreePath, input.branchHint)),
  init: publicProcedure.input(obj({ path: s })).mutation(({ input }) => initRepo(input.path)),
  getCurrentBranch: publicProcedure
    .input(obj({ path: s }))
    .query(({ input }) => getCurrentBranch(input.path)),
  listBranches: publicProcedure
    .input(obj({ path: s }))
    .query(({ input }) => listBranches(input.path)),
  checkoutBranch: publicProcedure
    .input(obj({ path: s, branch: s }))
    .mutation(({ input }) => checkoutBranch(input.path, input.branch)),
  createBranch: publicProcedure
    .input(obj({ path: s, branch: s }))
    .mutation(({ input }) => createBranch(input.path, input.branch)),
  hasUncommittedChanges: publicProcedure
    .input(obj({ path: s }))
    .query(({ input }) => hasUncommittedChanges(input.path)),
  mergeIntoParent: publicProcedure
    .input(obj({ projectPath: s, parentBranch: s, sourceBranch: s }))
    .mutation(({ input }) =>
      mergeIntoParent(input.projectPath, input.parentBranch, input.sourceBranch)
    ),
  abortMerge: publicProcedure.input(obj({ path: s })).mutation(({ input }) => abortMerge(input.path)),
  mergeWithAI: publicProcedure
    .input(obj({ projectPath: s, worktreePath: s, parentBranch: s, sourceBranch: s }))
    .mutation(({ input }) => mergeWithAI(input)),
  isMergeInProgress: publicProcedure
    .input(obj({ path: s }))
    .query(({ input }) => isMergeInProgress(input.path)),
  getConflictedFiles: publicProcedure
    .input(obj({ path: s }))
    .query(({ input }) => getConflictedFiles(input.path)),
  getWorkingDiff: publicProcedure
    .input(obj({ path: s, opts: u.optional() }))
    .query(({ input }) => getWorkingDiff(input.path, input.opts as never)),
  stageFile: publicProcedure
    .input(obj({ path: s, filePath: s }))
    .mutation(({ input }) => stageFile(input.path, input.filePath)),
  unstageFile: publicProcedure
    .input(obj({ path: s, filePath: s }))
    .mutation(({ input }) => unstageFile(input.path, input.filePath)),
  discardFile: publicProcedure
    .input(obj({ path: s, filePath: s, untracked: z.boolean().optional() }))
    .mutation(({ input }) => discardFile(input.path, input.filePath, input.untracked)),
  stageAll: publicProcedure.input(obj({ path: s })).mutation(({ input }) => stageAll(input.path)),
  unstageAll: publicProcedure
    .input(obj({ path: s }))
    .mutation(({ input }) => unstageAll(input.path)),
  getFileDiff: publicProcedure
    .input(obj({ repoPath: s, filePath: s, staged: z.boolean(), opts: u.optional() }))
    .query(({ input }) => getFileDiff(input.repoPath, input.filePath, input.staged, input.opts as never)),
  getUntrackedFileDiff: publicProcedure
    .input(obj({ repoPath: s, filePath: s }))
    .query(({ input }) => getUntrackedFileDiff(input.repoPath, input.filePath)),
  getConflictContent: publicProcedure
    .input(obj({ repoPath: s, filePath: s }))
    .query(({ input }) => getConflictContent(input.repoPath, input.filePath)),
  writeResolvedFile: publicProcedure
    .input(obj({ repoPath: s, filePath: s, content: s }))
    .mutation(({ input }) => writeResolvedFile(input.repoPath, input.filePath, input.content)),
  commitFiles: publicProcedure
    .input(obj({ repoPath: s, message: s }))
    .mutation(({ input }) => commitFiles(input.repoPath, input.message)),
  analyzeConflict: publicProcedure
    .input(obj({ mode: s, filePath: s, base: sn, ours: sn, theirs: sn }))
    .mutation(({ input }) =>
      analyzeConflict(input.mode, input.filePath, input.base, input.ours, input.theirs)
    ),

  // Rebase
  isRebaseInProgress: publicProcedure
    .input(obj({ path: s }))
    .query(({ input }) => isRebaseInProgress(input.path)),
  getRebaseProgress: publicProcedure
    .input(obj({ repoPath: s }))
    .query(({ input }) => getRebaseProgress(input.repoPath)),
  abortRebase: publicProcedure
    .input(obj({ path: s }))
    .mutation(({ input }) => abortRebase(input.path)),
  continueRebase: publicProcedure
    .input(obj({ path: s }))
    .mutation(({ input }) => continueRebase(input.path)),
  skipRebaseCommit: publicProcedure
    .input(obj({ path: s }))
    .mutation(({ input }) => skipRebaseCommit(input.path)),
  getMergeContext: publicProcedure
    .input(obj({ repoPath: s }))
    .query(({ input }) => getMergeContext(input.repoPath)),

  getRecentCommits: publicProcedure
    .input(obj({ repoPath: s, count: z.number().optional() }))
    .query(({ input }) => getRecentCommits(input.repoPath, input.count)),
  getAheadBehind: publicProcedure
    .input(obj({ repoPath: s, branch: s, upstream: s }))
    .query(({ input }) => getAheadBehind(input.repoPath, input.branch, input.upstream)),
  getStatusSummary: publicProcedure
    .input(obj({ repoPath: s }))
    .query(({ input }) => getStatusSummary(input.repoPath)),
  revealInFinder: publicProcedure.input(obj({ path: s })).mutation(async ({ input }) => {
    // .catch keeps the transport pkg loadable in non-Electron contexts
    // (esbuild leaves catch-guarded dynamic imports unresolved instead of erroring)
    const electron = (await import('electron').catch(() => null)) as typeof import('electron') | null
    if (!electron?.shell?.openPath) {
      throw new Error('revealInFinder unavailable in this server context (Electron-only)')
    }
    await electron.shell.openPath(input.path)
  }),
  isDirty: publicProcedure.input(obj({ path: s })).query(async ({ input }) => {
    const summary = await getStatusSummary(input.path)
    return summary.staged + summary.unstaged + summary.untracked > 0
  }),
  getRemoteUrl: publicProcedure
    .input(obj({ path: s }))
    .query(({ input }) => getRemoteUrl(input.path)),
  getAheadBehindUpstream: publicProcedure
    .input(obj({ path: s, branch: s }))
    .query(({ input }) => getAheadBehindUpstream(input.path, input.branch)),
  fetch: publicProcedure.input(obj({ path: s })).mutation(({ input }) => gitFetch(input.path)),
  push: publicProcedure
    .input(obj({ path: s, branch: s.optional(), force: z.boolean().optional() }))
    .mutation(({ input }) => gitPush(input.path, input.branch, input.force)),
  pull: publicProcedure.input(obj({ path: s })).mutation(({ input }) => gitPull(input.path)),

  // Branch tab
  getDefaultBranch: publicProcedure
    .input(obj({ path: s }))
    .query(({ input }) => getDefaultBranch(input.path)),
  listBranchesDetailed: publicProcedure
    .input(obj({ path: s }))
    .query(({ input }) => listBranchesDetailed(input.path)),
  listRemoteBranches: publicProcedure
    .input(obj({ path: s }))
    .query(({ input }) => listRemoteBranches(input.path)),
  getMergeBase: publicProcedure
    .input(obj({ path: s, branch1: s, branch2: s }))
    .query(({ input }) => getMergeBase(input.path, input.branch1, input.branch2)),
  getCommitsSince: publicProcedure
    .input(obj({ path: s, sinceRef: s, branch: s }))
    .query(({ input }) => getCommitsSince(input.path, input.sinceRef, input.branch)),
  getCommitsBeforeRef: publicProcedure
    .input(obj({ path: s, ref: s, count: z.number().optional() }))
    .query(({ input }) => getCommitsBeforeRef(input.path, input.ref, input.count)),
  deleteBranch: publicProcedure
    .input(obj({ path: s, branch: s, force: z.boolean().optional() }))
    .mutation(({ input }) => deleteBranch(input.path, input.branch, input.force)),
  pruneRemote: publicProcedure
    .input(obj({ path: s }))
    .mutation(({ input }) => pruneRemote(input.path)),

  // Worktree tab
  rebaseOnto: publicProcedure
    .input(obj({ path: s, ontoBranch: s }))
    .mutation(({ input }) => rebaseOnto(input.path, input.ontoBranch)),
  mergeFrom: publicProcedure
    .input(obj({ path: s, branch: s }))
    .mutation(({ input }) => mergeFrom(input.path, input.branch)),
  getDiffStats: publicProcedure
    .input(obj({ path: s, ref: s }))
    .query(({ input }) => getDiffStats(input.path, input.ref)),
  getWorktreeMetadata: publicProcedure
    .input(obj({ path: s }))
    .query(({ input }) => getWorktreeMetadata(input.path)),
  getCommitDag: publicProcedure
    .input(obj({ path: s, limit: z.number(), branches: z.array(s).optional() }))
    .query(({ input }) => getCommitDag(input.path, input.limit, input.branches)),
  resolveChildBranches: publicProcedure
    .input(obj({ path: s, baseBranch: s }))
    .query(({ input }) => resolveChildBranches(input.path, input.baseBranch)),
  resolveCopyBehavior: publicProcedure
    .input(obj({ projectId: s.optional() }))
    .query(({ ctx, input }) => resolveCopyBehavior(ctx.db, input.projectId)),
  getIgnoredFileTree: publicProcedure
    .input(obj({ repoPath: s }))
    .query(({ input }) => getIgnoredFileTree(input.repoPath)),
  copyIgnoredFiles: publicProcedure
    .input(obj({ repoPath: s, worktreePath: s, paths: z.array(s), mode: z.enum(['all', 'custom']).optional() }))
    .mutation(({ input }) =>
      copyIgnoredFiles(
        input.repoPath,
        input.worktreePath,
        input.mode ?? (input.paths.length > 0 ? 'custom' : 'all'),
        input.paths
      )
    ),

  getResolvedCommitDag: publicProcedure
    .input(obj({ path: s, limit: z.number(), branches: z.array(s).optional(), baseBranch: s }))
    .query(({ input }) =>
      getResolvedCommitDag(input.path, input.limit, input.branches, input.baseBranch)
    ),
  getResolvedForkGraph: publicProcedure
    .input(
      obj({
        targetPath: s,
        repoPath: s,
        activeBranch: s,
        compareBranch: s,
        activeBranchLabel: s,
        compareBranchLabel: s
      })
    )
    .query(({ input }) =>
      getResolvedForkGraph(
        input.targetPath,
        input.repoPath,
        input.activeBranch,
        input.compareBranch,
        input.activeBranchLabel,
        input.compareBranchLabel
      )
    ),
  getResolvedUpstreamGraph: publicProcedure
    .input(obj({ repoPath: s, branch: s }))
    .query(({ input }) => getResolvedUpstreamGraph(input.repoPath, input.branch)),
  getResolvedRecentCommits: publicProcedure
    .input(obj({ path: s, count: z.number(), branchName: s }))
    .query(({ input }) => getResolvedRecentCommits(input.path, input.count, input.branchName)),

  // Stashes
  listStashes: publicProcedure
    .input(obj({ repoPath: s }))
    .query(({ input }) => listStashes(input.repoPath)),
  createStash: publicProcedure
    .input(obj({ repoPath: s, message: s, includeUntracked: z.boolean(), keepIndex: z.boolean() }))
    .mutation(({ input }) =>
      createStash(input.repoPath, input.message, input.includeUntracked, input.keepIndex)
    ),
  applyStash: publicProcedure
    .input(obj({ repoPath: s, index: z.number() }))
    .mutation(({ input }) => applyStash(input.repoPath, input.index)),
  popStash: publicProcedure
    .input(obj({ repoPath: s, index: z.number() }))
    .mutation(({ input }) => popStash(input.repoPath, input.index)),
  dropStash: publicProcedure
    .input(obj({ repoPath: s, index: z.number() }))
    .mutation(({ input }) => dropStash(input.repoPath, input.index)),
  branchFromStash: publicProcedure
    .input(obj({ repoPath: s, index: z.number(), branchName: s }))
    .mutation(({ input }) => branchFromStash(input.repoPath, input.index, input.branchName)),
  getStashDiff: publicProcedure
    .input(obj({ repoPath: s, index: z.number() }))
    .query(({ input }) => getStashDiff(input.repoPath, input.index)),

  // GitHub CLI
  checkGhInstalled: publicProcedure.query(() => checkGhInstalled()),
  hasGithubRemote: publicProcedure
    .input(obj({ repoPath: s }))
    .query(({ input }) => hasGithubRemote(input.repoPath)),
  listOpenPrs: publicProcedure
    .input(obj({ repoPath: s }))
    .query(({ input }) => listOpenPrs(input.repoPath)),
  getPrByUrl: publicProcedure
    .input(obj({ repoPath: s, url: s }))
    .query(({ input }) => getPrByUrl(input.repoPath, input.url)),
  createPr: publicProcedure
    .input(z.unknown() as unknown as z.ZodType<CreatePrInput>)
    .mutation(({ input }) => createPr(input)),
  getPrComments: publicProcedure
    .input(obj({ repoPath: s, prNumber: z.number() }))
    .query(({ input }) => getPrComments(input.repoPath, input.prNumber)),
  addPrComment: publicProcedure
    .input(obj({ repoPath: s, prNumber: z.number(), body: s }))
    .mutation(({ input }) => addPrComment(input.repoPath, input.prNumber, input.body)),
  mergePr: publicProcedure
    .input(z.unknown() as unknown as z.ZodType<MergePrInput>)
    .mutation(({ input }) => mergePr(input)),
  getPrDiff: publicProcedure
    .input(obj({ repoPath: s, prNumber: z.number() }))
    .query(({ input }) => getPrDiff(input.repoPath, input.prNumber)),
  getGhUser: publicProcedure
    .input(obj({ repoPath: s }))
    .query(({ input }) => getGhUser(input.repoPath)),
  editPrComment: publicProcedure
    .input(z.unknown() as unknown as z.ZodType<EditPrCommentInput>)
    .mutation(({ input }) => editPrComment(input)),

  // Subscriptions — git fs-watcher broadcasts (refcounted via watchStart/watchStop).
  // Mirrors the `git:diff-changed` / `git:diff-watch-failed` IPC broadcasts; the
  // watcher is a singleton EventEmitter, so `.off` in teardown prevents leaks.
  onDiffChanged: publicProcedure.subscription(() =>
    observable<{ worktreePath: string }>((emit) => {
      const handler = (payload: { worktreePath: string }): void => emit.next(payload)
      const watcher = getGitWatcher()
      watcher.on('git:diff-changed', handler)
      return () => watcher.off('git:diff-changed', handler)
    })
  ),
  onDiffWatchFailed: publicProcedure.subscription(() =>
    observable<{ worktreePath: string }>((emit) => {
      const handler = (payload: { worktreePath: string }): void => emit.next(payload)
      const watcher = getGitWatcher()
      watcher.on('git:diff-watch-failed', handler)
      return () => watcher.off('git:diff-watch-failed', handler)
    })
  )
})
