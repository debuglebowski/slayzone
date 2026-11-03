/**
 * Where a git panel op runs: on the computer that holds the checkout. The caller's
 * target (task, project, explicit computer, or none = the caller's default) resolves
 * that computer exactly as the workspace fs does (`getWorkspace().resolveComputer`),
 * and the op leaves as one `git.op` request through the transport the hub wires
 * ({@link setGitOpTransport}). The computer runs the SAME table
 * (`@slayzone/worktrees/git-ops`) after validating and jailing the input.
 *
 * With no computer the op runs on the hub's own disk (the desktop before its local
 * computer enrolls) — refused first on a hub with processes switched off, so nothing
 * there ever touches project files.
 */
import type { SlayzoneDb } from '@slayzone/platform'
import { assertHubLocalExecEnabled } from '@slayzone/platform/hub-switch-refusal'
import { gitOpAbsolutePaths, type GitOpInput, type GitOpName } from '../shared/git-ops-contract'
import { runGitOpLocally, type GitOpResult } from './git-ops'
import { getGitWatcher } from './git-watcher'
import { getWorktreesRouterDepsOrNull, type WorktreesComputerTarget } from './worktrees-router-deps'

export interface GitOpTransport {
  /** One `git.op` request to `computerId`; answers the op's result. */
  request(
    computerId: string,
    params: { op: GitOpName; input: unknown; mutates: boolean }
  ): Promise<unknown>
  /** Start watching a checkout there (`git.watchStart`); reports arrive via
   *  {@link deliverGitWatchEvent}. */
  watchStart(computerId: string, params: { watchId: string; worktreePath: string }): Promise<void>
  watchStop(computerId: string, params: { watchId: string }): Promise<void>
}

let transport: GitOpTransport | null = null

/** Wired by the hub's composition (its computer gateway); null = none (tests, unwired). */
export function setGitOpTransport(next: GitOpTransport | null): void {
  transport = next
  routedWatches.clear()
}

/** Resolve the computer an op or watch on `path` runs on (null = this hub's disk). */
async function computerFor(
  target: WorktreesComputerTarget | undefined,
  path: string | undefined,
  db: SlayzoneDb | undefined
): Promise<string | null> {
  const deps = getWorktreesRouterDepsOrNull()
  if (!deps) return null
  // An explicit target wins; else the path names whose checkout this is.
  const resolvedTarget = target ?? (db && path ? await gitTargetForPath(db, path) : null) ?? {}
  return deps.getWorkspace().resolveComputer(resolvedTarget)
}

/**
 * The panel's watches, refcounted per checkout path: many panels on one checkout =
 * one watch. `computerId` null = the hub's own watcher (no computer).
 */
interface RoutedWatch {
  computerId: string | null
  watchId: string
  count: number
}
const routedWatches = new Map<string, RoutedWatch>()
let watchSeq = 0

/** `worktrees.watchStart`: watch where the checkout lives. */
export async function watchGitCheckout(worktreePath: string, db?: SlayzoneDb): Promise<void> {
  const existing = routedWatches.get(worktreePath)
  if (existing) {
    existing.count++
    return
  }
  const computerId = transport ? await computerFor(undefined, worktreePath, db) : null
  const again = routedWatches.get(worktreePath)
  if (again) {
    again.count++
    return
  }
  if (computerId != null && transport) {
    const watch: RoutedWatch = {
      computerId,
      watchId: `gw-${process.pid}-${++watchSeq}`,
      count: 1
    }
    routedWatches.set(worktreePath, watch)
    try {
      await transport.watchStart(computerId, { watchId: watch.watchId, worktreePath })
    } catch (err) {
      if (routedWatches.get(worktreePath) === watch) routedWatches.delete(worktreePath)
      throw err
    }
    return
  }
  getGitWatcher().subscribe(worktreePath)
  routedWatches.set(worktreePath, { computerId: null, watchId: '', count: 1 })
}

/** `worktrees.watchStop`: release one subscription; the last one ends the watch. */
export async function unwatchGitCheckout(worktreePath: string): Promise<void> {
  const watch = routedWatches.get(worktreePath)
  if (!watch) {
    // Started before routing existed (or on the hub's watcher directly).
    getGitWatcher().unsubscribe(worktreePath)
    return
  }
  if (--watch.count > 0) return
  routedWatches.delete(worktreePath)
  if (watch.computerId == null) {
    getGitWatcher().unsubscribe(worktreePath)
    return
  }
  await transport?.watchStop(watch.computerId, { watchId: watch.watchId }).catch(() => {
    /* the computer is gone — its watch went with it */
  })
}

/** A computer's watch report: emitted as the panel's own watcher event. */
export function deliverGitWatchEvent(
  computerId: string,
  event: { watchId: string; kind: 'changed' | 'failed'; refsChanged?: boolean }
): void {
  for (const [worktreePath, watch] of routedWatches) {
    if (watch.computerId !== computerId || watch.watchId !== event.watchId) continue
    if (event.kind === 'changed') {
      getGitWatcher().emit('git:diff-changed', {
        worktreePath,
        refsChanged: event.refsChanged === true
      })
    } else {
      routedWatches.delete(worktreePath)
      getGitWatcher().emit('git:diff-watch-failed', { worktreePath })
    }
    return
  }
}

/** A computer disconnected: its watches are gone — say so, and forget them. */
export function gitWatchComputerGone(computerId: string): void {
  for (const [worktreePath, watch] of [...routedWatches]) {
    if (watch.computerId !== computerId) continue
    routedWatches.delete(worktreePath)
    getGitWatcher().emit('git:diff-watch-failed', { worktreePath })
  }
}

function trimSlashes(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p
}

/**
 * Whose checkout `path` is, as the hub records it: a task's worktree (the task's
 * computer), else a project's folder on a computer (`project_placements`, not
 * forgotten) — the longest match, at a path boundary. The same folder on several
 * computers names only the project (its default computer decides). Null: unknown.
 */
export async function gitTargetForPath(
  db: SlayzoneDb,
  path: string
): Promise<WorktreesComputerTarget | null> {
  const p = trimSlashes(path)
  // `inside(col)`: p is col, or lies under col/ (substr compare: no LIKE escaping).
  const inside = (col: string) => `(${col} = ? OR substr(?, 1, length(${col}) + 1) = ${col} || '/')`
  const task = await db.get<{ id: string; worktree_path: string }>(
    `SELECT id, worktree_path FROM tasks
      WHERE worktree_path IS NOT NULL AND worktree_path != '' AND ${inside('worktree_path')}
      ORDER BY length(worktree_path) DESC LIMIT 1`,
    [p, p]
  )
  const placements = await db.all<{ computer_id: string; project_id: string; root_path: string }>(
    `SELECT computer_id, project_id, root_path FROM project_placements
      WHERE status != 'forgotten' AND root_path != '' AND ${inside('root_path')}
      ORDER BY length(root_path) DESC`,
    [p, p]
  )
  const longest = placements[0]
  if (task && (!longest || task.worktree_path.length >= longest.root_path.length)) {
    return { taskId: task.id }
  }
  if (!longest) return null
  const same = placements.filter((r) => r.root_path === longest.root_path)
  const computers = new Set(same.map((r) => r.computer_id))
  const projects = new Set(same.map((r) => r.project_id))
  if (computers.size === 1)
    return { computerId: longest.computer_id, projectId: longest.project_id }
  return projects.size === 1 ? { projectId: longest.project_id } : null
}

export async function executeGitOp<K extends GitOpName>(
  op: K,
  { target, ...input }: GitOpInput<K> & { target?: WorktreesComputerTarget },
  mutates: boolean,
  db?: SlayzoneDb
): Promise<GitOpResult<K>> {
  const repoPath = gitOpAbsolutePaths(op, input as GitOpInput<K>)[0]
  const computerId = await computerFor(target, repoPath, db)
  if (computerId != null && transport) {
    return (await transport.request(computerId, { op, input, mutates })) as GitOpResult<K>
  }
  assertHubLocalExecEnabled({ op: `worktrees.${op}` })
  return runGitOpLocally(op, input as GitOpInput<K>)
}
