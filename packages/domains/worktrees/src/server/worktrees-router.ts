import { z } from 'zod'
import { observable } from '@trpc/server/observable'
import { removeWorktree } from './git-worktree'
import {
  resolveCopyBehavior,
  detectWorktreesWithColors,
  createWorktreeWithSetup,
  mergeWithAI,
  analyzeConflict
} from './composite-ops'
import { detectChildRepos, listProjectRepos } from './list-project-repos'
import { getGitWatcher } from './git-watcher'
import {
  checkGhInstalled,
  hasGithubRemote,
  listOpenPrs,
  getPrByUrl,
  getPrForCheckout,
  createPr,
  getPrComments,
  addPrComment,
  mergePr,
  getPrDiff,
  getGhUser,
  editPrComment
} from './gh-cli'
import { worktreesEvents } from './events'
import type {
  CreateWorktreeOpts,
  CreateWorktreePhase,
  CreateWorktreePhaseEvent,
  CreatePrInput,
  MergePrInput,
  EditPrCommentInput
} from '../shared/types'
import type { GitDiffChangedPayload } from './git-watcher'
import { router, publicProcedure, hubLocalProcedure } from '@slayzone/trpc-server'
import { gitOpsContract } from '../shared/git-ops-contract'
import { runGitOpLocally } from './git-ops'
import { getWorktreesRouterDeps } from './worktrees-router-deps'

const u = z.unknown()
const s = z.string()
const sn = z.string().nullable()
const obj = z.object

/**
 * Most of this router runs git, `gh` probes and file reads on the HUB's own disk —
 * there is no computer route for them yet — so those procedures are
 * `hubLocalProcedure`: refused with `NO_COMPUTER_CONNECTED` on a hub with
 * `SLAYZONE_HUB_ENABLE_PROCESSES=0` (T-06), unchanged everywhere else. Still
 * `publicProcedure`: the routed ones (repo discovery through the workspace fs, the
 * `gh` calls behind the routed executor), DB reads, event subscriptions and
 * `watchStop`, which only releases a watcher.
 */
export const worktreesRouter = router({
  // Watch / unwatch (refcounted)
  watchStart: hubLocalProcedure.input(obj({ worktreePath: s })).mutation(({ input }) => {
    getGitWatcher().subscribe(input.worktreePath)
  }),
  watchStop: publicProcedure.input(obj({ worktreePath: s })).mutation(({ input }) => {
    getGitWatcher().unsubscribe(input.worktreePath)
  }),

  isGitRepo: hubLocalProcedure
    .input(gitOpsContract.isGitRepo.input)
    .query(({ input }) => runGitOpLocally('isGitRepo', input)),
  // Repo discovery runs on the machine that owns the directory — it decides the
  // terminal cwd, the editor root, and the git panel, so a hub-local walk pointed
  // all three at the wrong filesystem for any project living on a computer.
  // `projectId`/`taskId` resolve that machine the same way a pty spawn does.
  listProjectRepos: publicProcedure
    .input(
      obj({ projectPath: s, projectId: s.optional(), taskId: s.optional(), opts: u.optional() })
    )
    .query(async ({ input }) => {
      const { fs, resolveComputer } = getWorktreesRouterDeps().getWorkspace()
      const computerId = await resolveComputer(input)
      return listProjectRepos(fs, computerId, input.projectPath, (input.opts ?? {}) as never)
    }),
  detectChildRepos: publicProcedure
    .input(obj({ projectPath: s, projectId: s.optional(), taskId: s.optional() }))
    .query(async ({ input }) => {
      const { fs, resolveComputer } = getWorktreesRouterDeps().getWorkspace()
      const computerId = await resolveComputer(input)
      return detectChildRepos(fs, computerId, input.projectPath)
    }),
  detectWorktrees: hubLocalProcedure
    .input(obj({ repoPath: s }))
    .query(({ input }) => detectWorktreesWithColors(input.repoPath)),
  createWorktree: hubLocalProcedure.input(u).mutation(({ ctx, input }) => {
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
  removeWorktree: hubLocalProcedure
    .input(obj({ repoPath: s, worktreePath: s, branchHint: s.optional() }))
    .mutation(({ input }) => removeWorktree(input.repoPath, input.worktreePath, input.branchHint)),
  init: hubLocalProcedure
    .input(gitOpsContract.init.input)
    .mutation(({ input }) => runGitOpLocally('init', input)),
  getCurrentBranch: hubLocalProcedure
    .input(gitOpsContract.getCurrentBranch.input)
    .query(({ input }) => runGitOpLocally('getCurrentBranch', input)),
  listBranches: hubLocalProcedure
    .input(gitOpsContract.listBranches.input)
    .query(({ input }) => runGitOpLocally('listBranches', input)),
  checkoutBranch: hubLocalProcedure
    .input(gitOpsContract.checkoutBranch.input)
    .mutation(({ input }) => runGitOpLocally('checkoutBranch', input)),
  createBranch: hubLocalProcedure
    .input(gitOpsContract.createBranch.input)
    .mutation(({ input }) => runGitOpLocally('createBranch', input)),
  hasUncommittedChanges: hubLocalProcedure
    .input(gitOpsContract.hasUncommittedChanges.input)
    .query(({ input }) => runGitOpLocally('hasUncommittedChanges', input)),
  mergeIntoParent: hubLocalProcedure
    .input(gitOpsContract.mergeIntoParent.input)
    .mutation(({ input }) => runGitOpLocally('mergeIntoParent', input)),
  abortMerge: hubLocalProcedure
    .input(gitOpsContract.abortMerge.input)
    .mutation(({ input }) => runGitOpLocally('abortMerge', input)),
  mergeWithAI: hubLocalProcedure
    .input(obj({ projectPath: s, worktreePath: s, parentBranch: s, sourceBranch: s }))
    .mutation(({ input }) => mergeWithAI(input)),
  isMergeInProgress: hubLocalProcedure
    .input(gitOpsContract.isMergeInProgress.input)
    .query(({ input }) => runGitOpLocally('isMergeInProgress', input)),
  getConflictedFiles: hubLocalProcedure
    .input(gitOpsContract.getConflictedFiles.input)
    .query(({ input }) => runGitOpLocally('getConflictedFiles', input)),
  getWorkingDiff: hubLocalProcedure
    .input(gitOpsContract.getWorkingDiff.input)
    .query(({ input }) => runGitOpLocally('getWorkingDiff', input)),
  stageFile: hubLocalProcedure
    .input(gitOpsContract.stageFile.input)
    .mutation(({ input }) => runGitOpLocally('stageFile', input)),
  unstageFile: hubLocalProcedure
    .input(gitOpsContract.unstageFile.input)
    .mutation(({ input }) => runGitOpLocally('unstageFile', input)),
  discardFile: hubLocalProcedure
    .input(gitOpsContract.discardFile.input)
    .mutation(({ input }) => runGitOpLocally('discardFile', input)),
  stageAll: hubLocalProcedure
    .input(gitOpsContract.stageAll.input)
    .mutation(({ input }) => runGitOpLocally('stageAll', input)),
  unstageAll: hubLocalProcedure
    .input(gitOpsContract.unstageAll.input)
    .mutation(({ input }) => runGitOpLocally('unstageAll', input)),
  getFileDiff: hubLocalProcedure
    .input(gitOpsContract.getFileDiff.input)
    .query(({ input }) => runGitOpLocally('getFileDiff', input)),
  getUntrackedFileDiff: hubLocalProcedure
    .input(gitOpsContract.getUntrackedFileDiff.input)
    .query(({ input }) => runGitOpLocally('getUntrackedFileDiff', input)),
  getUntrackedFileDiffs: hubLocalProcedure
    .input(gitOpsContract.getUntrackedFileDiffs.input)
    .query(({ input }) => runGitOpLocally('getUntrackedFileDiffs', input)),
  getConflictContent: hubLocalProcedure
    .input(gitOpsContract.getConflictContent.input)
    .query(({ input }) => runGitOpLocally('getConflictContent', input)),
  writeResolvedFile: hubLocalProcedure
    .input(gitOpsContract.writeResolvedFile.input)
    .mutation(({ input }) => runGitOpLocally('writeResolvedFile', input)),
  commitFiles: hubLocalProcedure
    .input(gitOpsContract.commitFiles.input)
    .mutation(({ input }) => runGitOpLocally('commitFiles', input)),
  analyzeConflict: hubLocalProcedure
    .input(obj({ mode: s, filePath: s, base: sn, ours: sn, theirs: sn }))
    .mutation(({ input }) =>
      analyzeConflict(input.mode, input.filePath, input.base, input.ours, input.theirs)
    ),

  // Rebase
  isRebaseInProgress: hubLocalProcedure
    .input(gitOpsContract.isRebaseInProgress.input)
    .query(({ input }) => runGitOpLocally('isRebaseInProgress', input)),
  getRebaseProgress: hubLocalProcedure
    .input(gitOpsContract.getRebaseProgress.input)
    .query(({ input }) => runGitOpLocally('getRebaseProgress', input)),
  abortRebase: hubLocalProcedure
    .input(gitOpsContract.abortRebase.input)
    .mutation(({ input }) => runGitOpLocally('abortRebase', input)),
  continueRebase: hubLocalProcedure
    .input(gitOpsContract.continueRebase.input)
    .mutation(({ input }) => runGitOpLocally('continueRebase', input)),
  skipRebaseCommit: hubLocalProcedure
    .input(gitOpsContract.skipRebaseCommit.input)
    .mutation(({ input }) => runGitOpLocally('skipRebaseCommit', input)),
  getMergeContext: hubLocalProcedure
    .input(gitOpsContract.getMergeContext.input)
    .query(({ input }) => runGitOpLocally('getMergeContext', input)),
  getRecentCommits: hubLocalProcedure
    .input(gitOpsContract.getRecentCommits.input)
    .query(({ input }) => runGitOpLocally('getRecentCommits', input)),
  getAheadBehind: hubLocalProcedure
    .input(gitOpsContract.getAheadBehind.input)
    .query(({ input }) => runGitOpLocally('getAheadBehind', input)),
  getStatusSummary: hubLocalProcedure
    .input(gitOpsContract.getStatusSummary.input)
    .query(({ input }) => runGitOpLocally('getStatusSummary', input)),
  // Electron shell op (host-only) — forwarded over the capability bridge so it
  // runs in the Electron host when the renderer talks to the side-car.
  revealInFinder: hubLocalProcedure
    .input(obj({ path: s }))
    .mutation(({ input }) => getWorktreesRouterDeps().shellOpenPath(input.path)),
  isDirty: hubLocalProcedure
    .input(gitOpsContract.isDirty.input)
    .query(({ input }) => runGitOpLocally('isDirty', input)),
  getRemoteUrl: hubLocalProcedure
    .input(gitOpsContract.getRemoteUrl.input)
    .query(({ input }) => runGitOpLocally('getRemoteUrl', input)),
  getAheadBehindUpstream: hubLocalProcedure
    .input(gitOpsContract.getAheadBehindUpstream.input)
    .query(({ input }) => runGitOpLocally('getAheadBehindUpstream', input)),
  fetch: hubLocalProcedure
    .input(gitOpsContract.fetch.input)
    .mutation(({ input }) => runGitOpLocally('fetch', input)),
  push: hubLocalProcedure
    .input(gitOpsContract.push.input)
    .mutation(({ input }) => runGitOpLocally('push', input)),
  pull: hubLocalProcedure
    .input(gitOpsContract.pull.input)
    .mutation(({ input }) => runGitOpLocally('pull', input)),
  // Branch tab
  getDefaultBranch: hubLocalProcedure
    .input(gitOpsContract.getDefaultBranch.input)
    .query(({ input }) => runGitOpLocally('getDefaultBranch', input)),
  listBranchesDetailed: hubLocalProcedure
    .input(gitOpsContract.listBranchesDetailed.input)
    .query(({ input }) => runGitOpLocally('listBranchesDetailed', input)),
  listRemoteBranches: hubLocalProcedure
    .input(gitOpsContract.listRemoteBranches.input)
    .query(({ input }) => runGitOpLocally('listRemoteBranches', input)),
  getMergeBase: hubLocalProcedure
    .input(gitOpsContract.getMergeBase.input)
    .query(({ input }) => runGitOpLocally('getMergeBase', input)),
  getCommitsSince: hubLocalProcedure
    .input(gitOpsContract.getCommitsSince.input)
    .query(({ input }) => runGitOpLocally('getCommitsSince', input)),
  getCommitsBeforeRef: hubLocalProcedure
    .input(gitOpsContract.getCommitsBeforeRef.input)
    .query(({ input }) => runGitOpLocally('getCommitsBeforeRef', input)),
  deleteBranch: hubLocalProcedure
    .input(gitOpsContract.deleteBranch.input)
    .mutation(({ input }) => runGitOpLocally('deleteBranch', input)),
  pruneRemote: hubLocalProcedure
    .input(gitOpsContract.pruneRemote.input)
    .mutation(({ input }) => runGitOpLocally('pruneRemote', input)),
  // Worktree tab
  rebaseOnto: hubLocalProcedure
    .input(gitOpsContract.rebaseOnto.input)
    .mutation(({ input }) => runGitOpLocally('rebaseOnto', input)),
  mergeFrom: hubLocalProcedure
    .input(gitOpsContract.mergeFrom.input)
    .mutation(({ input }) => runGitOpLocally('mergeFrom', input)),
  getDiffStats: hubLocalProcedure
    .input(gitOpsContract.getDiffStats.input)
    .query(({ input }) => runGitOpLocally('getDiffStats', input)),
  getWorktreeMetadata: hubLocalProcedure
    .input(gitOpsContract.getWorktreeMetadata.input)
    .query(({ input }) => runGitOpLocally('getWorktreeMetadata', input)),
  getCommitDag: hubLocalProcedure
    .input(gitOpsContract.getCommitDag.input)
    .query(({ input }) => runGitOpLocally('getCommitDag', input)),
  resolveChildBranches: hubLocalProcedure
    .input(gitOpsContract.resolveChildBranches.input)
    .query(({ input }) => runGitOpLocally('resolveChildBranches', input)),
  resolveCopyBehavior: publicProcedure
    .input(obj({ projectId: s.optional() }))
    .query(({ ctx, input }) => resolveCopyBehavior(ctx.db, input.projectId)),
  getIgnoredFileTree: hubLocalProcedure
    .input(gitOpsContract.getIgnoredFileTree.input)
    .query(({ input }) => runGitOpLocally('getIgnoredFileTree', input)),
  copyIgnoredFiles: hubLocalProcedure
    .input(gitOpsContract.copyIgnoredFiles.input)
    .mutation(({ input }) => runGitOpLocally('copyIgnoredFiles', input)),
  getResolvedCommitDag: hubLocalProcedure
    .input(gitOpsContract.getResolvedCommitDag.input)
    .query(({ input }) => runGitOpLocally('getResolvedCommitDag', input)),
  getResolvedForkGraph: hubLocalProcedure
    .input(gitOpsContract.getResolvedForkGraph.input)
    .query(({ input }) => runGitOpLocally('getResolvedForkGraph', input)),
  getResolvedUpstreamGraph: hubLocalProcedure
    .input(gitOpsContract.getResolvedUpstreamGraph.input)
    .query(({ input }) => runGitOpLocally('getResolvedUpstreamGraph', input)),
  getResolvedRecentCommits: hubLocalProcedure
    .input(gitOpsContract.getResolvedRecentCommits.input)
    .query(({ input }) => runGitOpLocally('getResolvedRecentCommits', input)),
  // Stashes
  listStashes: hubLocalProcedure
    .input(gitOpsContract.listStashes.input)
    .query(({ input }) => runGitOpLocally('listStashes', input)),
  createStash: hubLocalProcedure
    .input(gitOpsContract.createStash.input)
    .mutation(({ input }) => runGitOpLocally('createStash', input)),
  applyStash: hubLocalProcedure
    .input(gitOpsContract.applyStash.input)
    .mutation(({ input }) => runGitOpLocally('applyStash', input)),
  popStash: hubLocalProcedure
    .input(gitOpsContract.popStash.input)
    .mutation(({ input }) => runGitOpLocally('popStash', input)),
  dropStash: hubLocalProcedure
    .input(gitOpsContract.dropStash.input)
    .mutation(({ input }) => runGitOpLocally('dropStash', input)),
  branchFromStash: hubLocalProcedure
    .input(gitOpsContract.branchFromStash.input)
    .mutation(({ input }) => runGitOpLocally('branchFromStash', input)),
  getStashDiff: hubLocalProcedure
    .input(gitOpsContract.getStashDiff.input)
    .query(({ input }) => runGitOpLocally('getStashDiff', input)),
  // GitHub CLI
  // Routed like every gh call: answered by the machine that would run gh for this
  // checkout (a computer), not the hub — so not hub-local-gated here.
  checkGhInstalled: publicProcedure
    .input(obj({ repoPath: s }))
    .query(({ input }) => checkGhInstalled(input.repoPath)),
  hasGithubRemote: hubLocalProcedure
    .input(obj({ repoPath: s }))
    .query(({ input }) => hasGithubRemote(input.repoPath)),
  listOpenPrs: publicProcedure
    .input(obj({ repoPath: s }))
    .query(({ input }) => listOpenPrs(input.repoPath)),
  getPrByUrl: publicProcedure
    .input(obj({ repoPath: s, url: s }))
    .query(({ input }) => getPrByUrl(input.repoPath, input.url)),
  getPrForCheckout: publicProcedure
    .input(obj({ repoPath: s, branch: s }))
    .query(({ input }) => getPrForCheckout(input.repoPath, input.branch)),
  createPr: hubLocalProcedure
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
    observable<GitDiffChangedPayload>((emit) => {
      const handler = (payload: GitDiffChangedPayload): void => emit.next(payload)
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

export type WorktreesRouter = typeof worktreesRouter

/**
 * Where this domain's router sits in the app router. `@slayzone/api` mounts
 * `worktreesRouter` at `worktrees` and asserts the slice in its `router.ts`.
 */
export type WorktreesMounts = { worktrees: WorktreesRouter }
