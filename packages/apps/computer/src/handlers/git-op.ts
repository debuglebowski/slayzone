/**
 * `git.op`: the git panel's operations, run on THIS computer through the same table
 * the hub declares (`@slayzone/worktrees/git-ops`) — one implementation, not a copy.
 *
 * Every call: the op must be in the shared contract, its input must pass the
 * contract's schema, every absolute path it names is judged by the computer's one
 * path jail (`../path-jail`), and every repo-relative path (a file to stage, a
 * conflict to write) must stay inside the op's repo — before git or fs is touched.
 * The op then runs on the JUDGED paths, never the raw ones.
 *
 * @module computer/handlers/git-op
 */
import { isAbsolute, relative } from 'node:path'
import {
  ComputerNotificationMethods,
  GIT_WATCH_EVENT,
  HubToComputerMethods,
  gitOpParamsSchema,
  gitTurnOpParamsSchema,
  gitWatchStartParamsSchema,
  gitWatchStopParamsSchema,
  type GitWatchEvent
} from '@slayzone/computer-transport/shared'
import {
  configureGitExec,
  createGitWatcher,
  type GitDiffChangedPayload,
  gitOpAbsolutePaths,
  gitOpsContract,
  mapGitOpPaths,
  isGitOpName,
  runGitOpLocally,
  type GitOpInput,
  type GitOpName
} from '@slayzone/worktrees/git-ops'
import {
  isTurnGitOpName,
  runTurnGitOpLocally,
  turnGitContract,
  type TurnGitOpInput
} from '@slayzone/agent-turns/turn-git'
import { jailedFs, judgePath, judgePathIn, JailViolationError } from '../path-jail'
import type { HandlerContext, HubMethodTable } from './types'

export function createGitOpHandlers(
  ctx: HandlerContext,
  hooks: {
    /** Register what to do when the hub connection goes away. */
    onHubDisconnected?: (cb: () => void) => void
  } = {}
): HubMethodTable {
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
  const allow = (candidate: string): string => judgePath(candidate, ctx.config.allowedRoots)

  async function gitOp(raw: unknown): Promise<{ result: unknown }> {
    const { op, input } = gitOpParamsSchema.parse(raw)
    if (!isGitOpName(op)) throw new Error(`unknown git op '${op}'`)
    const name: GitOpName = op
    const asSent = gitOpsContract[name].input.parse(input) as GitOpInput<typeof name>
    const repoRaw = gitOpAbsolutePaths(name, asSent)[0]
    const repo = repoRaw === undefined ? undefined : allow(repoRaw)
    // Judged, and the op runs on what was judged: each absolute path by the jail;
    // each repo-relative one kept inside the repo (lexically, as git reads a
    // pathspec — git itself never follows a link in the work tree) and judged as
    // the entry it names.
    const parsed = mapGitOpPaths(name, asSent, {
      absolute: allow,
      repoRelative: (rel) => {
        if (!repo || isAbsolute(rel)) {
          throw new JailViolationError(`path '${rel}' must stay inside the repository`)
        }
        let path: string
        try {
          path = judgePathIn(repo, rel, ctx.config.allowedRoots, { access: 'entry' }).path
        } catch (err) {
          if (err instanceof JailViolationError && err.message.startsWith('Path traversal')) {
            throw new JailViolationError(`path '${rel}' must stay inside the repository`)
          }
          throw err
        }
        // The repo itself (`''`, `.`) stays as sent: a file op never widens to `.`.
        const inRepo = relative(repo, path)
        return inRepo === '' ? rel : inRepo
      }
    })
    if (name === 'writeResolvedFile') {
      // Written by the jail where it was judged, never through a link.
      const { repoPath, filePath, content } = parsed as GitOpInput<'writeResolvedFile'>
      jailedFs.writeFile(
        judgePathIn(repoPath, filePath, ctx.config.allowedRoots, { access: 'write' }).path,
        content
      )
      return { result: null }
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
    const { watchId, worktreePath: rawPath } = gitWatchStartParamsSchema.parse(raw)
    const worktreePath = allow(rawPath)
    if (watchPaths.has(watchId)) return { ok: true }
    // Subscribe first: a watch that failed to start is never recorded as live.
    watcher.subscribe(worktreePath)
    watchPaths.set(watchId, worktreePath)
    // Answer once the watch is live (Q4): a change right after this is reported, and
    // one made while it started comes as the change `ready` sends.
    await watcher.ready(worktreePath)
    return { ok: true }
  }

  // The hub that started these is gone; the next one starts its own under new ids.
  // Left open, each reconnect added one more recursive fs.watch.
  hooks.onHubDisconnected?.(() => {
    for (const [watchId, worktreePath] of watchPaths) {
      watchPaths.delete(watchId)
      watcher.unsubscribe(worktreePath)
    }
  })

  async function watchStop(raw: unknown): Promise<{ ok: true }> {
    const { watchId } = gitWatchStopParamsSchema.parse(raw)
    const worktreePath = watchPaths.get(watchId)
    if (worktreePath === undefined) return { ok: true }
    watchPaths.delete(watchId)
    watcher.unsubscribe(worktreePath)
    return { ok: true }
  }

  /** Agent-turn git (snapshot, dedupe, the list's filter), same table as the hub's. */
  async function gitTurnOp(raw: unknown): Promise<{ result: unknown }> {
    const { op, input } = gitTurnOpParamsSchema.parse(raw)
    if (!isTurnGitOpName(op)) throw new Error(`unknown turn op '${op}'`)
    const input0 = turnGitContract[op].parse(input) as TurnGitOpInput<typeof op>
    const parsed = { ...input0, repoPath: allow(input0.repoPath) }
    const result = await runTurnGitOpLocally(op, parsed)
    return { result: result ?? null }
  }

  return {
    [HubToComputerMethods.gitOp]: gitOp,
    [HubToComputerMethods.gitTurnOp]: gitTurnOp,
    [HubToComputerMethods.gitWatchStart]: watchStart,
    [HubToComputerMethods.gitWatchStop]: watchStop
  }
}
