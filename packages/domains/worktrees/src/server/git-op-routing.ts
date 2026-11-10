/**
 * Where a git panel op runs: on the computer that holds the checkout. Every op names
 * its PATH SCOPE — the task or project whose checkout it works on (§9 Phase 7b): the
 * hub authorizes that scope, resolves its computer exactly as the workspace fs does
 * (`getWorkspace().resolveComputer`), and sends one `git.op` request under it
 * (`@slayzone/platform/path-scope`) through the transport the hub wires
 * ({@link setGitOpTransport}). The computer runs the SAME table
 * (`@slayzone/worktrees/git-ops`) after validating the input and jailing every path
 * to that scope's own folders, which only it knows. The hub never decides whose a
 * path is: it no longer knows a task's worktree.
 *
 * With no computer the op is refused — "connect a computer" — on every hub: the hub
 * never runs git or reads a checkout itself.
 */
import type { SlayzoneDb } from '@slayzone/platform'
import { inPathScopeOf, PathScopeRequiredError } from '@slayzone/platform/path-scope'
import { refuseNoComputer } from '@slayzone/platform/hub-switch-refusal'
import { gitOpTimeoutMs, type GitOpInput, type GitOpName } from '../shared/git-ops-contract'
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

/** A path-taking op's scope: the task or project it names, else refused. */
export type GitScope = WorktreesComputerTarget & ({ taskId: string } | { projectId: string })

function requireScope(
  target: WorktreesComputerTarget | undefined,
  op: string
): asserts target is GitScope {
  if (!target?.taskId && !target?.projectId) throw new PathScopeRequiredError(op)
}

/** Resolve the computer an op or watch on `target` runs on (null = none). */
async function computerFor(target: GitScope): Promise<string | null> {
  const deps = getWorktreesRouterDepsOrNull()
  if (!deps) return null
  return deps.getWorkspace().resolveComputer(target)
}

/**
 * The panel's watches, refcounted per (scope, checkout path): many panels on one
 * checkout = one watch. Keyed by scope too: the computer judged the path under it,
 * and its events are owner-checked by it.
 */
interface RoutedWatch {
  computerId: string
  watchId: string
  worktreePath: string
  owner: { taskId?: string; projectId?: string }
  count: number
  /** The computer's start: a panel joining while it is in flight waits for it (M3). */
  started: Promise<void>
}
const routedWatches = new Map<string, RoutedWatch>()
let watchSeq = 0

/** One watch per scope and checkout. */
function watchKey(target: GitScope, worktreePath: string): string {
  return JSON.stringify([target.taskId ?? null, target.projectId ?? null, worktreePath])
}

/** The scope a watch's events carry, for their owner check. */
function ownerOf(target: GitScope): { taskId?: string; projectId?: string } {
  return target.taskId ? { taskId: target.taskId } : { projectId: target.projectId }
}

/** `worktrees.watchStart`: watch where the checkout lives, under its scope. */
export async function watchGitCheckout(
  worktreePath: string,
  target: WorktreesComputerTarget | undefined,
  db: SlayzoneDb
): Promise<void> {
  requireScope(target, 'worktrees.watchStart')
  const key = watchKey(target, worktreePath)
  const existing = routedWatches.get(key)
  if (existing) return join(existing)
  const computerId = transport ? await computerFor(target) : null
  const again = routedWatches.get(key)
  if (again) return join(again)
  if (computerId == null || !transport) refuseNoComputer({ op: 'worktrees.watchStart' })
  const live = transport
  const watchId = `gw-${process.pid}-${++watchSeq}`
  const owner = ownerOf(target)
  const started = inPathScopeOf(db, target, 'worktrees.watchStart', () =>
    live.watchStart(computerId, { watchId, worktreePath })
  )
  const watch: RoutedWatch = { computerId, watchId, worktreePath, owner, count: 1, started }
  routedWatches.set(key, watch)
  try {
    await started
  } catch (err) {
    // Everyone counted on it is told — a panel that joined meanwhile too (M3).
    if (routedWatches.get(key) === watch) {
      routedWatches.delete(key)
      getGitWatcher().emit('git:diff-watch-failed', { worktreePath, ...owner })
    }
    throw err
  }
}

/** Count one more panel on a watch — live once its start is (a failed one throws). */
async function join(watch: RoutedWatch): Promise<void> {
  watch.count++
  await watch.started
}

/** `worktrees.watchStop`: release one subscription; the last one ends the watch. */
export async function unwatchGitCheckout(
  worktreePath: string,
  target: WorktreesComputerTarget | undefined
): Promise<void> {
  requireScope(target, 'worktrees.watchStop')
  const key = watchKey(target, worktreePath)
  const watch = routedWatches.get(key)
  if (!watch) return // never started (refused), or its computer is gone
  if (--watch.count > 0) return
  routedWatches.delete(key)
  await transport?.watchStop(watch.computerId, { watchId: watch.watchId }).catch(() => {
    /* the computer is gone — its watch went with it */
  })
}

/** A computer's watch report: emitted as the panel's own watcher event. */
export function deliverGitWatchEvent(
  computerId: string,
  event: { watchId: string; kind: 'changed' | 'failed'; refsChanged?: boolean }
): void {
  for (const [key, watch] of routedWatches) {
    if (watch.computerId !== computerId || watch.watchId !== event.watchId) continue
    const { worktreePath, owner } = watch
    if (event.kind === 'changed') {
      getGitWatcher().emit('git:diff-changed', {
        worktreePath,
        refsChanged: event.refsChanged === true,
        ...owner
      })
    } else {
      routedWatches.delete(key)
      getGitWatcher().emit('git:diff-watch-failed', { worktreePath, ...owner })
    }
    return
  }
}

/** A computer disconnected: its watches are gone — say so, and forget them. */
export function gitWatchComputerGone(computerId: string): void {
  for (const [key, watch] of [...routedWatches]) {
    if (watch.computerId !== computerId) continue
    routedWatches.delete(key)
    getGitWatcher().emit('git:diff-watch-failed', {
      worktreePath: watch.worktreePath,
      ...watch.owner
    })
  }
}

/**
 * Run one git op on its scope's computer, under that scope: the computer confines
 * every path the op names to the scope's folders. An op naming no task or project
 * is refused — the hub cannot tell whose a bare path is.
 */
export async function executeGitOp<K extends GitOpName>(
  op: K,
  { target, ...input }: GitOpInput<K> & { target?: WorktreesComputerTarget },
  mutates: boolean,
  db: SlayzoneDb
): Promise<GitOpResult<K>> {
  requireScope(target, `worktrees.${op}`)
  const computerId = await computerFor(target)
  if (computerId == null || !transport) refuseNoComputer({ op: `worktrees.${op}` })
  const live = transport
  return (await inPathScopeOf(db, target, `worktrees.${op}`, () =>
    live.request(computerId, { op, input, mutates }, gitOpTimeoutMs(op), target)
  )) as GitOpResult<K>
}
