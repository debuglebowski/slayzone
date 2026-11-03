/**
 * `git.op`: the git panel's operations, run on THIS computer through the same table
 * the hub declares (`@slayzone/worktrees/git-ops`) — one implementation, not a copy.
 *
 * Every call: the op must be in the shared contract, its input must pass the
 * contract's schema, every absolute path it names must pass the jail
 * ({@link assertPathAllowed}), and every repo-relative path (a file to stage, a
 * conflict to write) must stay inside the op's repo — before git or fs is touched.
 *
 * @module computer/handlers/git-op
 */
import { isAbsolute, relative, resolve } from 'node:path'
import {
  ComputerNotificationMethods,
  GIT_WATCH_EVENT,
  HubToComputerMethods,
  gitOpParamsSchema,
  gitWatchStartParamsSchema,
  gitWatchStopParamsSchema,
  type GitWatchEvent
} from '@slayzone/computer-transport/shared'
import {
  configureGitExec,
  createGitWatcher,
  type GitDiffChangedPayload,
  gitOpAbsolutePaths,
  gitOpRepoRelativePaths,
  gitOpsContract,
  isGitOpName,
  runGitOpLocally,
  type GitOpInput,
  type GitOpName
} from '@slayzone/worktrees/git-ops'
import { assertPathAllowed, JailViolationError } from '../config'
import type { HandlerContext, HubMethodTable } from './types'

function insideRepo(repo: string, rel: string): boolean {
  if (isAbsolute(rel)) return false
  const back = relative(repo, resolve(repo, rel))
  return (
    back !== '..' && !back.startsWith(`..${'/'}`) && !back.startsWith('..\\') && !isAbsolute(back)
  )
}

export function createGitOpHandlers(ctx: HandlerContext): HubMethodTable {
  // This process adopted the login-shell PATH at boot, and running git is its job:
  // no hub refusal here, and its diagnostics go to its own log.
  configureGitExec({
    loginShellPath: () => null,
    refuse: () => undefined,
    diagnostic: (event) => {
      if (event.level === 'error') ctx.log(`git: ${event.message}`, { event: event.event })
    }
  })
  // Read the jail through `ctx` on every call: `computer.setAllowedRoots` edits it live.
  const allow = (candidate: string): string => assertPathAllowed(candidate, ctx.config.allowedRoots)

  async function gitOp(raw: unknown): Promise<{ result: unknown }> {
    const { op, input } = gitOpParamsSchema.parse(raw)
    if (!isGitOpName(op)) throw new Error(`unknown git op '${op}'`)
    const name: GitOpName = op
    const parsed = gitOpsContract[name].input.parse(input) as GitOpInput<typeof name>
    const paths = gitOpAbsolutePaths(name, parsed)
    for (const p of paths) allow(p)
    const repo = paths[0]
    for (const rel of gitOpRepoRelativePaths(name, parsed)) {
      if (!repo || !insideRepo(repo, rel))
        throw new JailViolationError(`path '${rel}' must stay inside the repository`)
      allow(resolve(repo, rel))
    }
    const result = await runGitOpLocally(name, parsed)
    return { result: result ?? null }
  }

  // The git panel's live refresh: one refcounted watcher per checkout, reports sent
  // under every hub watch id on that checkout.
  const watcher = createGitWatcher({ refuse: () => undefined })
  const watchPaths = new Map<string, string>() // watchId → worktreePath
  const report = (event: GitWatchEvent): void => {
    ctx.dialer.notify(ComputerNotificationMethods.event, { name: GIT_WATCH_EVENT, payload: event })
  }
  const idsFor = (worktreePath: string): string[] =>
    [...watchPaths].filter(([, p]) => p === worktreePath).map(([id]) => id)
  watcher.on('git:diff-changed', ({ worktreePath, refsChanged }: GitDiffChangedPayload) => {
    for (const watchId of idsFor(worktreePath)) report({ watchId, kind: 'changed', refsChanged })
  })
  watcher.on('git:diff-watch-failed', ({ worktreePath }: { worktreePath: string }) => {
    for (const watchId of idsFor(worktreePath)) {
      watchPaths.delete(watchId)
      report({ watchId, kind: 'failed' })
    }
  })

  async function watchStart(raw: unknown): Promise<{ ok: true }> {
    const { watchId, worktreePath } = gitWatchStartParamsSchema.parse(raw)
    allow(worktreePath)
    if (watchPaths.has(watchId)) return { ok: true }
    watchPaths.set(watchId, worktreePath)
    watcher.subscribe(worktreePath)
    return { ok: true }
  }

  async function watchStop(raw: unknown): Promise<{ ok: true }> {
    const { watchId } = gitWatchStopParamsSchema.parse(raw)
    const worktreePath = watchPaths.get(watchId)
    if (worktreePath === undefined) return { ok: true }
    watchPaths.delete(watchId)
    watcher.unsubscribe(worktreePath)
    return { ok: true }
  }

  return {
    [HubToComputerMethods.gitOp]: gitOp,
    [HubToComputerMethods.gitWatchStart]: watchStart,
    [HubToComputerMethods.gitWatchStop]: watchStop
  }
}
