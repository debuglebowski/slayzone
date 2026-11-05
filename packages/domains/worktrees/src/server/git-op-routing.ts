/**
 * Where a git panel op runs: on the computer that holds the checkout. The caller's
 * target (task, project, explicit computer, or none = the caller's default) resolves
 * that computer exactly as the workspace fs does (`getWorkspace().resolveComputer`),
 * and the op leaves as one `git.op` request through the transport the hub wires
 * ({@link setGitOpTransport}). The computer runs the SAME table
 * (`@slayzone/worktrees/git-ops`) after validating and jailing the input.
 *
 * With no computer the op is refused — "connect a computer" — on every hub: the hub
 * never runs git or reads a checkout itself.
 */
import type { SlayzoneDb } from '@slayzone/platform'
import { computerPathWithin, normalizeComputerPath } from '@slayzone/platform/computer-path'
import { refuseNoComputer } from '@slayzone/platform/hub-switch-refusal'
import {
  gitOpAbsolutePaths,
  gitOpTimeoutMs,
  type GitOpInput,
  type GitOpName
} from '../shared/git-ops-contract'
import type { GitOpResult } from './git-ops'
import { getGitWatcher } from './git-watcher'
import { getWorktreesRouterDepsOrNull, type WorktreesComputerTarget } from './worktrees-router-deps'

export interface GitOpTransport {
  /** One `git.op` request to `computerId`; answers the op's result. */
  request(
    computerId: string,
    params: { op: GitOpName; input: unknown; mutates: boolean },
    /** The op's own limit ({@link gitOpTimeoutMs}) — pass it on as the request's. */
    timeoutMs: number,
    /** What the op works on, as resolved (a task's checkout, a project …): its gate. */
    target: WorktreesComputerTarget
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

/** What an op on `path` works on: an explicit target, else whose checkout the path is. */
async function targetFor(
  target: WorktreesComputerTarget | undefined,
  path: string | undefined,
  db: SlayzoneDb | undefined
): Promise<WorktreesComputerTarget> {
  return target ?? (db && path ? await gitTargetForPath(db, path) : null) ?? {}
}

/** Resolve the computer an op or watch on `path` runs on (null = none). */
async function computerFor(
  target: WorktreesComputerTarget | undefined,
  path: string | undefined,
  db: SlayzoneDb | undefined
): Promise<string | null> {
  const deps = getWorktreesRouterDepsOrNull()
  if (!deps) return null
  return deps.getWorkspace().resolveComputer(await targetFor(target, path, db))
}

/** The panel's watches, refcounted per checkout path: many panels on one checkout = one watch. */
interface RoutedWatch {
  computerId: string
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
  if (computerId == null || !transport) refuseNoComputer({ op: 'worktrees.watchStart' })
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
}

/** `worktrees.watchStop`: release one subscription; the last one ends the watch. */
export async function unwatchGitCheckout(worktreePath: string): Promise<void> {
  const watch = routedWatches.get(worktreePath)
  if (!watch) return // never started (refused), or its computer is gone
  if (--watch.count > 0) return
  routedWatches.delete(worktreePath)
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

/**
 * Whose checkout `path` is, as the hub records it: a task's worktree (the task's
 * computer), else a project's folder on a computer (`project_placements`, not
 * forgotten) — the longest match, at a path boundary. The same folder on several
 * computers names only the project (its default computer decides). Null: unknown.
 *
 * Both sides — the asked path and every stored one — are compared in the ONE form
 * the owner policy also uses (`@slayzone/platform/computer-path`), so routing and
 * the policy never disagree on whose a path is (G2), and a Windows path stored with
 * `/` still matches (G5). In JS: SQL cannot normalize the stored side.
 */
export async function gitTargetForPath(
  db: SlayzoneDb,
  path: string
): Promise<WorktreesComputerTarget | null> {
  const p = normalizeComputerPath(path)
  const tasks = (
    await db.all<{ id: string; worktree_path: string }>(
      `SELECT id, worktree_path FROM tasks WHERE worktree_path IS NOT NULL AND worktree_path != ''`
    )
  ).map((r) => ({ id: r.id, root: normalizeComputerPath(r.worktree_path) }))
  const placements = (
    await db.all<{ computer_id: string; project_id: string; root_path: string }>(
      `SELECT computer_id, project_id, root_path FROM project_placements
        WHERE status != 'forgotten' AND root_path != ''`
    )
  ).map((r) => ({ ...r, root: normalizeComputerPath(r.root_path) }))
  // Letter case compared exactly first, as the owner policy compares a project root:
  // the owning computer folds case for its own volume, the hub's disk cannot say (L3).
  const exact = targetAmong(tasks, placements, (root) => computerPathWithin(p, root))
  if (exact) return exact
  // No exact match: a checkout recorded in another letter case (a Mac's
  // `/Users/k/Proj` asked for as `/Users/k/proj`) is taken when it is the ONLY
  // candidate — routing only; the gateway's owner check still decides (N6). Two
  // candidates that differ only in case are not guessed between.
  const folded = (root: string) => computerPathWithin(p, root, true)
  const hits = [...tasks, ...placements].filter((r) => folded(r.root)).map((r) => r.root)
  // The deepest recorded folder decides, as with an exact match.
  const deepest = Math.max(-1, ...hits.map((root) => root.length))
  const candidates = new Set(hits.filter((root) => root.length === deepest))
  if (candidates.size !== 1) return null
  const only = [...candidates][0] as string
  return targetAmong(
    tasks.filter((t) => t.root === only),
    placements.filter((r) => r.root === only),
    folded
  )
}

/**
 * The deepest recorded checkout `under` accepts: a task's worktree (the task's
 * computer), else a project folder on a computer. The same folder on several
 * computers names only the project; on several projects, nothing.
 */
function targetAmong(
  tasks: ReadonlyArray<{ id: string; root: string }>,
  placements: ReadonlyArray<{ computer_id: string; project_id: string; root: string }>,
  under: (root: string) => boolean
): WorktreesComputerTarget | null {
  let task: { id: string; root: string } | null = null
  for (const t of tasks) {
    if (under(t.root) && (!task || t.root.length > task.root.length)) task = t
  }
  const matched = placements
    .filter((r) => under(r.root))
    .sort((a, b) => b.root.length - a.root.length)
  const longest = matched[0]
  if (task && (!longest || task.root.length >= longest.root.length)) {
    return { taskId: task.id }
  }
  if (!longest) return null
  const same = matched.filter((r) => r.root === longest.root)
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
  const deps = getWorktreesRouterDepsOrNull()
  const resolved = await targetFor(target, repoPath, db)
  const computerId = deps ? await deps.getWorkspace().resolveComputer(resolved) : null
  if (computerId == null || !transport) refuseNoComputer({ op: `worktrees.${op}` })
  return (await transport.request(
    computerId,
    { op, input, mutates },
    gitOpTimeoutMs(op),
    resolved
  )) as GitOpResult<K>
}
