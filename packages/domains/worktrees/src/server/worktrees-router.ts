import { z } from 'zod'
import type { SlayzoneDb } from '@slayzone/platform'
import { observable } from '@trpc/server/observable'
import {
  resolveCopyBehavior,
  detectWorktreesWithColors,
  createWorktreeWithSetup,
  mergeWithAI,
  analyzeConflict,
  type WorktreeSetupExec
} from './composite-ops'
import { detectChildRepos, listProjectRepos } from './list-project-repos'
import { getGitWatcher } from './git-watcher'
import {
  checkGhInstalled,
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
import type { WithAmbientTarget } from '@slayzone/trpc-server'
import { gitOpsContract, type GitOpName } from '../shared/git-ops-contract'
import { executeGitOp, unwatchGitCheckout, watchGitCheckout } from './git-op-routing'
import { getWorktreesRouterDeps } from './worktrees-router-deps'
import { inPathScopeOf, PathScopeRequiredError } from '@slayzone/platform/path-scope'

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
/**
 * What a git panel op works on — its PATH SCOPE (§9 Phase 7b): the task or project
 * whose checkout it touches, required. The hub authorizes the scope and routes to
 * its computer (`computerId` picks among a project's computers); the computer
 * confines every path to that scope's folders. A bare path names nobody.
 */
export type GitScope = { computerId?: string | null } & (
  | { taskId: string; projectId?: string }
  | { taskId?: undefined; projectId: string }
)
// Typed as the scope it validates: a caller naming neither fails typecheck.
const gitTarget = obj({
  computerId: sn.optional(),
  taskId: s.optional(),
  projectId: s.optional()
})
  .refine((t) => !!t.taskId || !!t.projectId, 'name the task or project (target)')
  // Absent at run time = `PathScopeRequiredError` (a clear refusal), not a schema
  // dump; the TYPE still requires it.
  .optional() as unknown as z.ZodType<GitScope, GitScope>
// Required in the type too: every caller names its scope. Only the panel's scoped
// proxy (client/trpc.ts) is typed with `WorktreesAmbientMounts`, where it is
// optional because the proxy adds it from the panel's provider.
type Target = z.infer<typeof gitTarget> | undefined

/** An input naming its scope at the top level (`taskId` / `projectId`), typed so. */
const scopedTop = <S extends z.ZodRawShape>(shape: S) =>
  obj({
    ...shape,
    computerId: sn.optional(),
    taskId: s.optional(),
    projectId: s.optional()
  }).refine((t) => {
    const v = t as { taskId?: string; projectId?: string }
    return !!v.taskId || !!v.projectId
  }, 'name the task or project (taskId / projectId)') as unknown as z.ZodType<
    z.infer<z.ZodObject<S>> & GitScope,
    z.input<z.ZodObject<S>> & GitScope
  >

/** Run `fn` in the path scope `target` names (gh calls route by it). */
const scoped = <T>(db: SlayzoneDb, target: Target, op: string, fn: () => Promise<T>) =>
  inPathScopeOf(db, target, `worktrees.${op}`, fn)

/**
 * A git panel op (`gitOpsContract`): its contract input plus an optional `target`,
 * run on the computer that holds the checkout (see git-op-routing.ts). Not
 * hub-local-gated: routed ops work on any hub; only the no-computer fallback onto the
 * hub's disk is refused where processes are off. A mutation says so to the audit log.
 */
/** A typed input the handler validates itself, plus the required scope. */
function scopedInput<T>() {
  return z
    .looseObject({ target: gitTarget })
    .transform((v) => v as unknown as T & { target: Target })
}

function gitQuery<K extends GitOpName>(op: K) {
  return publicProcedure
    .input(gitOpsContract[op].input.extend({ target: gitTarget }))
    .query(({ ctx, input }) => executeGitOp(op, input as never, false, ctx.db))
}
function gitMutation<K extends GitOpName>(op: K) {
  return publicProcedure
    .input(gitOpsContract[op].input.extend({ target: gitTarget }))
    .mutation(({ ctx, input }) => executeGitOp(op, input as never, true, ctx.db))
}

/** `createWorktree`'s steps, each on the scope's computer, under the scope. */
function routedWorktreeSetup(db: SlayzoneDb, target: Target): WorktreeSetupExec {
  return {
    createWorktree: (repoPath, targetPath, branch, sourceBranch) =>
      executeGitOp('addWorktree', { repoPath, targetPath, branch, sourceBranch, target }, true, db),
    copyIgnoredFiles: (repoPath, worktreePath, mode, paths) =>
      executeGitOp('copyIgnoredFiles', { repoPath, worktreePath, mode, paths, target }, true, db),
    initSubmodules: (worktreePath) =>
      executeGitOp('initSubmodules', { worktreePath, target }, true, db),
    runWorktreeSetupScript: (worktreePath, repoPath, sourceBranch) =>
      executeGitOp(
        'runWorktreeSetupScript',
        { worktreePath, repoPath, sourceBranch, target },
        true,
        db
      )
  }
}

export const worktreesRouter = router({
  // Watch / unwatch (refcounted)
  // Routed like the ops: the watch runs where the checkout lives; reports arrive as
  // the same `onDiffChanged` events (see git-op-routing.ts).
  watchStart: publicProcedure
    .input(obj({ worktreePath: s, target: gitTarget }))
    .mutation(({ ctx, input }) => watchGitCheckout(input.worktreePath, input.target, ctx.db)),
  watchStop: publicProcedure
    .input(obj({ worktreePath: s, target: gitTarget }))
    .mutation(({ input }) => unwatchGitCheckout(input.worktreePath, input.target)),

  isGitRepo: gitQuery('isGitRepo'),
  // Repo discovery runs on the machine that owns the directory — it decides the
  // terminal cwd, the editor root, and the git panel, so a hub-local walk pointed
  // all three at the wrong filesystem for any project living on a computer.
  // `projectId`/`taskId` resolve that machine the same way a pty spawn does.
  listProjectRepos: publicProcedure
    .input(scopedTop({ projectPath: s, opts: u.optional() }))
    .query(async ({ ctx, input }) => {
      const { fs, resolveComputer } = getWorktreesRouterDeps().getWorkspace()
      return scoped(ctx.db, input, 'listProjectRepos', async () => {
        const computerId = await resolveComputer(input)
        return listProjectRepos(fs, computerId, input.projectPath, (input.opts ?? {}) as never)
      })
    }),
  detectChildRepos: publicProcedure
    .input(scopedTop({ projectPath: s }))
    .query(async ({ ctx, input }) => {
      const { fs, resolveComputer } = getWorktreesRouterDeps().getWorkspace()
      return scoped(ctx.db, input, 'detectChildRepos', async () => {
        const computerId = await resolveComputer(input)
        return detectChildRepos(fs, computerId, input.projectPath)
      })
    }),
  // The git runs on the checkout's computer; the worktree colors are the hub's.
  detectWorktrees: publicProcedure
    .input(obj({ repoPath: s, target: gitTarget }))
    .query(({ ctx, input }) =>
      detectWorktreesWithColors(input.repoPath, (repoPath) =>
        executeGitOp('listWorktrees', { repoPath, target: input.target }, false, ctx.db)
      )
    ),
  // Each step runs on the checkout's computer; the copy/submodule policy and the
  // phase events stay here.
  createWorktree: publicProcedure.input(u).mutation(({ ctx, input }) => {
    const { target: sent, ...opts } = input as CreateWorktreeOpts & { target?: unknown }
    // The panel's scope (client/trpc.ts adds it), else the task / project the options
    // name. `opts.projectId` stays the copy-policy switch it always was.
    const target = gitTarget.parse(sent ?? { taskId: opts.taskId, projectId: opts.projectId })
    if (!target) throw new PathScopeRequiredError('worktrees.createWorktree')
    const { requestId } = opts
    const onPhase = requestId
      ? (phase: CreateWorktreePhase): void => {
          worktreesEvents.emit('createWorktree:phase', { requestId, phase })
        }
      : undefined
    return createWorktreeWithSetup(ctx.db, opts, onPhase, routedWorktreeSetup(ctx.db, target))
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
  removeWorktree: gitMutation('removeWorktree'),
  init: gitMutation('init'),
  getCurrentBranch: gitQuery('getCurrentBranch'),
  listBranches: gitQuery('listBranches'),
  checkoutBranch: gitMutation('checkoutBranch'),
  createBranch: gitMutation('createBranch'),
  hasUncommittedChanges: gitQuery('hasUncommittedChanges'),
  mergeIntoParent: gitMutation('mergeIntoParent'),
  abortMerge: gitMutation('abortMerge'),
  // The merge runs on the checkout's computer; the agent's prompt is built here.
  mergeWithAI: publicProcedure
    .input(
      obj({
        projectPath: s,
        worktreePath: s,
        parentBranch: s,
        sourceBranch: s,
        target: gitTarget
      })
    )
    .mutation(({ ctx, input: { target, ...input } }) =>
      mergeWithAI(input, {
        hasUncommittedChanges: (path) =>
          executeGitOp('hasUncommittedChanges', { path, target }, false, ctx.db),
        startMergeNoCommit: (projectPath, parentBranch, sourceBranch) =>
          executeGitOp(
            'startMergeNoCommit',
            { projectPath, parentBranch, sourceBranch, target },
            true,
            ctx.db
          )
      })
    ),
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
    .input(obj({ repoPath: s, target: gitTarget }))
    .query(({ ctx, input }) =>
      scoped(ctx.db, input.target, 'checkGhInstalled', () => checkGhInstalled(input.repoPath))
    ),
  hasGithubRemote: gitQuery('hasGithubRemote'),
  listOpenPrs: publicProcedure
    .input(obj({ repoPath: s, target: gitTarget }))
    .query(({ ctx, input }) =>
      scoped(ctx.db, input.target, 'listOpenPrs', () => listOpenPrs(input.repoPath))
    ),
  getPrByUrl: publicProcedure
    .input(obj({ repoPath: s, url: s, target: gitTarget }))
    .query(({ ctx, input }) =>
      scoped(ctx.db, input.target, 'getPrByUrl', () => getPrByUrl(input.repoPath, input.url))
    ),
  getPrForCheckout: publicProcedure
    .input(obj({ repoPath: s, branch: s, target: gitTarget }))
    .query(({ ctx, input }) =>
      scoped(ctx.db, input.target, 'getPrForCheckout', () =>
        getPrForCheckout(input.repoPath, input.branch)
      )
    ),
  // The branch is pushed on the checkout's computer (the routed op), then `gh`
  // opens the PR through the routed gh executor — both under the scope.
  createPr: publicProcedure
    .input(scopedInput<CreatePrInput>())
    .mutation(({ ctx, input: { target, ...input } }) =>
      scoped(ctx.db, target, 'createPr', () =>
        createPr(input, async (repoPath) => {
          await executeGitOp('ensureBranchPushed', { repoPath, target }, true, ctx.db)
        })
      )
    ),
  getPrComments: publicProcedure
    .input(obj({ repoPath: s, prNumber: z.number(), target: gitTarget }))
    .query(({ ctx, input }) =>
      scoped(ctx.db, input.target, 'getPrComments', () =>
        getPrComments(input.repoPath, input.prNumber)
      )
    ),
  addPrComment: publicProcedure
    .input(obj({ repoPath: s, prNumber: z.number(), body: s, target: gitTarget }))
    .mutation(({ ctx, input }) =>
      scoped(ctx.db, input.target, 'addPrComment', () =>
        addPrComment(input.repoPath, input.prNumber, input.body)
      )
    ),
  mergePr: publicProcedure
    .input(scopedInput<MergePrInput>())
    .mutation(({ ctx, input: { target, ...input } }) =>
      scoped(ctx.db, target, 'mergePr', () => mergePr(input))
    ),
  getPrDiff: publicProcedure
    .input(obj({ repoPath: s, prNumber: z.number(), target: gitTarget }))
    .query(({ ctx, input }) =>
      scoped(ctx.db, input.target, 'getPrDiff', () => getPrDiff(input.repoPath, input.prNumber))
    ),
  getGhUser: publicProcedure
    .input(obj({ repoPath: s, target: gitTarget }))
    .query(({ ctx, input }) =>
      scoped(ctx.db, input.target, 'getGhUser', () => getGhUser(input.repoPath))
    ),
  editPrComment: publicProcedure
    .input(scopedInput<EditPrCommentInput>())
    .mutation(({ ctx, input: { target, ...input } }) =>
      scoped(ctx.db, target, 'editPrComment', () => editPrComment(input))
    ),

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
/** The git panel's scoped-proxy view: `target` optional (the proxy adds it). */
export type WorktreesAmbientMounts = { worktrees: WithAmbientTarget<WorktreesRouter> }
