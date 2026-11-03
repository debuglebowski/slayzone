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
import { gitOpsContract, type GitOpName } from '../shared/git-ops-contract'
import { executeGitOp } from './git-op-routing'
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
/** Which computer a git panel op runs on — the same target the workspace fs takes. */
const gitTarget = obj({
  computerId: sn.optional(),
  taskId: s.optional(),
  projectId: s.optional()
}).optional()

/**
 * A git panel op (`gitOpsContract`): its contract input plus an optional `target`,
 * run on the computer that holds the checkout (see git-op-routing.ts). Not
 * hub-local-gated: routed ops work on any hub; only the no-computer fallback onto the
 * hub's disk is refused where processes are off. A mutation says so to the audit log.
 */
function gitQuery<K extends GitOpName>(op: K) {
  return publicProcedure
    .input(gitOpsContract[op].input.extend({ target: gitTarget }))
    .query(({ input }) => executeGitOp(op, input as never, false))
}
function gitMutation<K extends GitOpName>(op: K) {
  return publicProcedure
    .input(gitOpsContract[op].input.extend({ target: gitTarget }))
    .mutation(({ input }) => executeGitOp(op, input as never, true))
}

export const worktreesRouter = router({
  // Watch / unwatch (refcounted)
  watchStart: hubLocalProcedure.input(obj({ worktreePath: s })).mutation(({ input }) => {
    getGitWatcher().subscribe(input.worktreePath)
  }),
  watchStop: publicProcedure.input(obj({ worktreePath: s })).mutation(({ input }) => {
    getGitWatcher().unsubscribe(input.worktreePath)
  }),

  isGitRepo: gitQuery('isGitRepo'),
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
  init: gitMutation('init'),
  getCurrentBranch: gitQuery('getCurrentBranch'),
  listBranches: gitQuery('listBranches'),
  checkoutBranch: gitMutation('checkoutBranch'),
  createBranch: gitMutation('createBranch'),
  hasUncommittedChanges: gitQuery('hasUncommittedChanges'),
  mergeIntoParent: gitMutation('mergeIntoParent'),
  abortMerge: gitMutation('abortMerge'),
  mergeWithAI: hubLocalProcedure
    .input(obj({ projectPath: s, worktreePath: s, parentBranch: s, sourceBranch: s }))
    .mutation(({ input }) => mergeWithAI(input)),
  isMergeInProgress: gitQuery('isMergeInProgress'),
  getConflictedFiles: gitQuery('getConflictedFiles'),
  getWorkingDiff: gitQuery('getWorkingDiff'),
  stageFile: gitMutation('stageFile'),
  unstageFile: gitMutation('unstageFile'),
  discardFile: gitMutation('discardFile'),
  stageAll: gitMutation('stageAll'),
  unstageAll: gitMutation('unstageAll'),
  getFileDiff: gitQuery('getFileDiff'),
  getUntrackedFileDiff: gitQuery('getUntrackedFileDiff'),
  getUntrackedFileDiffs: gitQuery('getUntrackedFileDiffs'),
  getConflictContent: gitQuery('getConflictContent'),
  writeResolvedFile: gitMutation('writeResolvedFile'),
  commitFiles: gitMutation('commitFiles'),
  analyzeConflict: hubLocalProcedure
    .input(obj({ mode: s, filePath: s, base: sn, ours: sn, theirs: sn }))
    .mutation(({ input }) =>
      analyzeConflict(input.mode, input.filePath, input.base, input.ours, input.theirs)
    ),

  // Rebase
  isRebaseInProgress: gitQuery('isRebaseInProgress'),
  getRebaseProgress: gitQuery('getRebaseProgress'),
  abortRebase: gitMutation('abortRebase'),
  continueRebase: gitMutation('continueRebase'),
  skipRebaseCommit: gitMutation('skipRebaseCommit'),
  getMergeContext: gitQuery('getMergeContext'),
  getRecentCommits: gitQuery('getRecentCommits'),
  getAheadBehind: gitQuery('getAheadBehind'),
  getStatusSummary: gitQuery('getStatusSummary'),
  // Electron shell op (host-only) — forwarded over the capability bridge so it
  // runs in the Electron host when the renderer talks to the side-car.
  revealInFinder: hubLocalProcedure
    .input(obj({ path: s }))
    .mutation(({ input }) => getWorktreesRouterDeps().shellOpenPath(input.path)),
  isDirty: gitQuery('isDirty'),
  getRemoteUrl: gitQuery('getRemoteUrl'),
  getAheadBehindUpstream: gitQuery('getAheadBehindUpstream'),
  fetch: gitMutation('fetch'),
  push: gitMutation('push'),
  pull: gitMutation('pull'),
  // Branch tab
  getDefaultBranch: gitQuery('getDefaultBranch'),
  listBranchesDetailed: gitQuery('listBranchesDetailed'),
  listRemoteBranches: gitQuery('listRemoteBranches'),
  getMergeBase: gitQuery('getMergeBase'),
  getCommitsSince: gitQuery('getCommitsSince'),
  getCommitsBeforeRef: gitQuery('getCommitsBeforeRef'),
  deleteBranch: gitMutation('deleteBranch'),
  pruneRemote: gitMutation('pruneRemote'),
  // Worktree tab
  rebaseOnto: gitMutation('rebaseOnto'),
  mergeFrom: gitMutation('mergeFrom'),
  getDiffStats: gitQuery('getDiffStats'),
  getWorktreeMetadata: gitQuery('getWorktreeMetadata'),
  getCommitDag: gitQuery('getCommitDag'),
  resolveChildBranches: gitQuery('resolveChildBranches'),
  resolveCopyBehavior: publicProcedure
    .input(obj({ projectId: s.optional() }))
    .query(({ ctx, input }) => resolveCopyBehavior(ctx.db, input.projectId)),
  getIgnoredFileTree: gitQuery('getIgnoredFileTree'),
  copyIgnoredFiles: gitMutation('copyIgnoredFiles'),
  getResolvedCommitDag: gitQuery('getResolvedCommitDag'),
  getResolvedForkGraph: gitQuery('getResolvedForkGraph'),
  getResolvedUpstreamGraph: gitQuery('getResolvedUpstreamGraph'),
  getResolvedRecentCommits: gitQuery('getResolvedRecentCommits'),
  // Stashes
  listStashes: gitQuery('listStashes'),
  createStash: gitMutation('createStash'),
  applyStash: gitMutation('applyStash'),
  popStash: gitMutation('popStash'),
  dropStash: gitMutation('dropStash'),
  branchFromStash: gitMutation('branchFromStash'),
  getStashDiff: gitQuery('getStashDiff'),
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
