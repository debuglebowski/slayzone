/**
 * The PATH SCOPE of a hub → computer request (robustness plan §9, Phase 7b).
 *
 * A request that touches computer paths (git panel, file editor, test scan, turn
 * list) names a task or a project. The hub authorizes that scope — owner, role,
 * placement — and NOTHING about the paths: it no longer knows a task's worktree
 * (P0: the computer holds it). The scope rides with the request, beside the actor,
 * and the computer confines EVERY path judged while serving it to the scope's own
 * roots, read from its own store: a task's worktree, else its base dir, else its
 * project's folder; a project's folder. A path that resolves into another task's
 * root, or outside every root of the scope, is refused — even when the caller
 * also owns that other task.
 *
 * Ambient, like the security context (security-log.ts): the router opens the scope
 * once ({@link runInPathScope}) and every computer request sent inside it carries
 * it (the gateway stamps it). A request sent outside any scope carries none and is
 * judged by the computer's machine bound (`allowedRoots`) as before — only the
 * callers this phase moved run scoped; the rest follow in 7c and 7e ratchets them.
 *
 * Import-light (node:async_hooks only): both the hub and the computer use it. The
 * wire schema is `wirePathScopeSchema` in computer-transport's frames.
 *
 * @module platform/path-scope
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { SlayzoneDb } from './db'
import { isHubLoginRequired } from './hub-switches'

/**
 * A scope as it travels. A task scope carries the task's project as the hub records
 * it (task → project is hub data, not a path), so a computer that holds no paths
 * row for the task still confines it to its project's folder there.
 * `hostReads`: the hub has no login (its one local user), so a user-chosen file to
 * copy IN (`fs.copyIn` source) may come from anywhere on the computer's machine
 * bound, as before; with login it must lie inside the scope too.
 */
export type WirePathScope =
  | { kind: 'task'; taskId: string; projectId: string | null; hostReads?: boolean }
  | {
      kind: 'project'
      projectId: string
      hostReads?: boolean
      /**
       * The hub's `worktree_base_path` setting, a TEMPLATE (`../{project-folder-name}-
       * workspaces`, `{project}/…`, an absolute folder), when one is set: the computer
       * resolves it against the project's folder THERE and covers it as one of the
       * project's roots (B1, its Worktrees tab), beside the default base it always
       * covers. A template names no particular machine, so the hub can send it.
       */
      worktreeBase?: string
    }

/** What a path-taking request names: a task, else a project. */
export interface PathScopeTarget {
  taskId?: string | null
  projectId?: string | null
  /**
   * The op is about the task's whole PROJECT — its Worktrees tab: listing, polling
   * and removing every worktree of the project, another task's or none — so it runs
   * in the task's project's scope, routed and authorized through the task (task →
   * project is hub data; a project is the root of ownership). Ignored without a task.
   */
  projectWide?: boolean
}

const store = new AsyncLocalStorage<WirePathScope>()

/** Run `fn` with `scope` as the path scope of every computer request it sends. */
export function runInPathScope<T>(scope: WirePathScope, fn: () => T): T {
  return store.run(scope, fn)
}

/** The path scope of the running request, if one was opened. */
export function currentPathScope(): WirePathScope | undefined {
  return store.getStore()
}

/**
 * The scope a caller's target names: its task, else its project; null when it
 * names neither, or a task this hub does not have. Task → project is hub data.
 */
export async function pathScopeFor(
  db: Pick<SlayzoneDb, 'get'>,
  target: PathScopeTarget,
  /** Whether this hub has no login (its one local user). Default: from env. */
  singleUser: boolean = !isHubLoginRequired()
): Promise<WirePathScope | null> {
  const hostReads = singleUser || undefined
  const project = async (projectId: string): Promise<WirePathScope> => {
    const value = (
      await db.get<{ value: unknown }>(
        "SELECT value FROM settings WHERE key = 'worktree_base_path'"
      )
    )?.value
    const template = typeof value === 'string' ? value.trim() : ''
    return {
      kind: 'project',
      projectId,
      hostReads,
      ...(template ? { worktreeBase: template } : {})
    }
  }
  if (target.taskId) {
    const row = await db.get<{ project_id: string | null }>(
      'SELECT project_id FROM tasks WHERE id = ?',
      [target.taskId]
    )
    if (!row) return null
    if (target.projectWide === true) return row.project_id ? project(row.project_id) : null
    return { kind: 'task', taskId: target.taskId, projectId: row.project_id, hostReads }
  }
  if (target.projectId) return project(target.projectId)
  return null
}

/**
 * Run `fn` in the scope `target` names, or refuse: a path-taking request must name
 * the task or project whose files it touches (§9 Phase 7b — the hub no longer knows
 * whose a path is).
 */
export async function inPathScopeOf<T>(
  db: Pick<SlayzoneDb, 'get'>,
  target: PathScopeTarget | null | undefined,
  op: string,
  fn: () => Promise<T>
): Promise<T> {
  const scope = target ? await pathScopeFor(db, target) : null
  if (!scope) throw new PathScopeRequiredError(op)
  return runInPathScope(scope, fn)
}

/** Refused at the router: a path-taking request must name a task or a project. */
export class PathScopeRequiredError extends Error {
  constructor(op: string) {
    super(`${op} must name the task or project whose files it touches`)
    this.name = 'PathScopeRequiredError'
  }
}

/**
 * The JSON-RPC code a computer answers a request it refuses by its OWN policy — its
 * path jail (a path outside the request's scope or machine bound, a link out of it,
 * its own state), a project not placed there (T-27). The same number as
 * computer-transport's `ComputerTransportErrorCodes.refusedByComputer`, kept here so
 * the transports (tRPC, REST) can recognise the refusal without importing that domain.
 */
export const COMPUTER_REFUSED_RPC_CODE = -32006

/** The stable code a computer's refusal carries to a client (`data.appCode`, REST `code`). */
export const COMPUTER_REFUSED = 'COMPUTER_REFUSED'

/**
 * Is `err` a computer's refusal by its own policy (an `RpcError` with
 * {@link COMPUTER_REFUSED_RPC_CODE})? Structural, as it crosses module copies: a
 * conflict the caller can resolve (pick another folder, place the project), never a
 * server fault — tRPC `CONFLICT`, REST 409.
 */
export function isComputerRefusal(err: unknown): err is Error & { code: number } {
  return (
    err instanceof Error &&
    err.name === 'RpcError' &&
    (err as { code?: unknown }).code === COMPUTER_REFUSED_RPC_CODE
  )
}
