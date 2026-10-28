/**
 * Which computer a piece of work runs on, and whether it may (T-19).
 *
 * Every exec path asks here: pty and chat spawns, the warm pool, worktree and git
 * work, the workspace filesystem, `gh`. The decisions are transport's
 * `computer-access.ts` (T-17's `canAccess`): a computer works only for its owner.
 *
 * WITHOUT LOGIN (the desktop app's hub) nothing changes: a task's binding, else its
 * project's default, else the connected default computer (the sole usable one, else
 * the one named {@link DEFAULT_LOCAL_COMPUTER_NAME}), and no gate. Not one query is
 * added on that path.
 *
 * WITH LOGIN:
 *   - a binding must name a computer owned by the task's (project's) owner, else the
 *     work is refused — the binding may predate ownership, or point at a computer
 *     its owner lost;
 *   - an unbound task picks among the usable computers its OWNER owns (same rule:
 *     the sole one, else the local-named one). None → "bind a computer", even when
 *     someone else's computer is the only one connected;
 *   - a caller naming a computer directly (the directory picker, the file editor)
 *     gets only their own, and with nothing named, their own default;
 *   - {@link ComputerPlacement.gate} is asked again by every routing backend right
 *     before a request leaves for a computer (`exec-proxies.ts`), so a computer id
 *     that reached a spawn spec some other way is still checked against the work.
 *
 * The caller of a direct request is read from the security context the tRPC and REST
 * entry points set (`runWithSecurityContext`); it only ever NARROWS — no actor means
 * no computer.
 *
 * @module hub/computer-placement
 */
import { DEFAULT_LOCAL_COMPUTER_NAME, resolveTaskComputerId } from '@slayzone/computers/server'
import type { ComputerWork, ComputerWorkGate } from '@slayzone/computer-transport/server'
import type { SlayzoneDb } from '@slayzone/platform'
import { currentSecurityContext, securityEvent } from '@slayzone/platform/security-log'
import { computerServes, mayUseComputer, resource, type OwnedResource } from '@slayzone/api'
import type { WorkspaceComputerTarget } from '@slayzone/file-editor/server'

/** A connected computer, as the gateway lists it. */
export interface UsableComputer {
  readonly computerId: string
  readonly name?: string
}

/** Raised on a hub with login when work has no computer of its owner's to run on. */
export class BindComputerError extends Error {
  constructor(what: string) {
    super(
      `No computer of yours is connected to run ${what}: bind a computer you own to this ` +
        `task or its project (Settings → Computers). On this hub work runs only on its ` +
        `owner's computers.`
    )
    this.name = 'BindComputerError'
  }
}

/** Raised when a computer may not do the work it was named for. Says nothing about
 *  whether it exists or whose it is. */
export class ComputerNotYoursError extends Error {
  constructor() {
    super('no such computer, or it is not yours: bind a computer you own')
    this.name = 'ComputerNotYoursError'
  }
}

export interface ComputerPlacementDeps {
  db: SlayzoneDb
  /** `SLAYZONE_HUB_REQUIRE_LOGIN`. Off: today's resolution, no gate. */
  requireLogin: boolean
  /** Connected AND heard from inside the heartbeat window (the gateway's
   *  `listUsableComputers`); empty until the gateway is up. */
  usable: () => readonly UsableComputer[]
}

export interface ComputerPlacement {
  /** The routing backends' resolver: a spec's computer, else (no login only) the
   *  connected default. Synchronous: pty-manager's local path needs a sync handle. */
  forSpec(computerId: string | null | undefined): string | null
  /** A task's computer. With login: refuses (throws) rather than return null. */
  forTask(taskId: string): Promise<string | null>
  /** A project's computer. With login: null when it has none of its owner's. */
  forProject(projectId: string): Promise<string | null>
  /** The workspace filesystem's target: an explicit computer, a task, a project, or
   *  the caller's default. */
  forTarget(target: WorkspaceComputerTarget): Promise<string | null>
  /** The caller's default computer (`gh`, a picker with no target). */
  forCaller(): Promise<string | null>
  /** The check before a request leaves for a computer; undefined without login. */
  readonly gate: ComputerWorkGate | undefined
  /** Whether this computer may hold a project's paths (its owner owns the project).
   *  Always true without login. */
  servesProject(computerId: string, projectId: string): Promise<boolean>
}

/** The connected default among `candidates`: the sole one, else the local-named one. */
function pickDefault(candidates: readonly UsableComputer[]): string | null {
  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0].computerId
  return candidates.find((r) => r.name === DEFAULT_LOCAL_COMPUTER_NAME)?.computerId ?? null
}

const callerPrincipal = (): { userId: string } | null => {
  const actor = currentSecurityContext()?.actor
  return actor ? { userId: actor } : null
}

function auditRefusal(computerId: string, work: OwnedResource | null): void {
  securityEvent({
    event: 'authz.denied',
    outcome: 'denied',
    targetKind: 'computer',
    targetId: computerId,
    detail: { reason: 'not_owner', ...(work ? { work: work.kind, workId: work.id } : {}) }
  })
}

export function createComputerPlacement(deps: ComputerPlacementDeps): ComputerPlacement {
  const { db, requireLogin } = deps

  /** May this computer do `work` (a resource), or the caller's own request (null)? */
  const serves = (computerId: string, work: OwnedResource | null): Promise<boolean> =>
    work
      ? computerServes(db, true, computerId, work)
      : mayUseComputer(db, { authRequired: true, principal: callerPrincipal() }, computerId)

  /** Throw unless this computer may do `work`. */
  const admit = async (computerId: string, work: OwnedResource | null): Promise<void> => {
    if (await serves(computerId, work)) return
    auditRefusal(computerId, work)
    throw new ComputerNotYoursError()
  }

  /** The connected default among the computers that may do `work`. */
  const pickFor = async (work: OwnedResource | null): Promise<string | null> => {
    const candidates: UsableComputer[] = []
    for (const c of deps.usable()) if (await serves(c.computerId, work)) candidates.push(c)
    return pickDefault(candidates)
  }

  const projectBinding = async (projectId: string): Promise<string | null> => {
    const row = await db.get<{ default_computer_id?: string | null }>(
      'SELECT default_computer_id FROM projects WHERE id = ?',
      [projectId]
    )
    return row?.default_computer_id ?? null
  }

  const forTask = async (taskId: string): Promise<string | null> => {
    const bound = await resolveTaskComputerId(db, taskId)
    if (!requireLogin) return bound ?? pickDefault(deps.usable())
    const work = resource('task', taskId)
    if (bound !== null) {
      await admit(bound, work)
      return bound
    }
    const picked = await pickFor(work)
    if (picked === null) throw new BindComputerError(`task ${taskId}`)
    return picked
  }

  const forProject = async (projectId: string): Promise<string | null> => {
    const bound = await projectBinding(projectId)
    if (!requireLogin) return bound ?? pickDefault(deps.usable())
    const work = resource('project', projectId)
    if (bound !== null) return (await serves(bound, work)) ? bound : null
    return pickFor(work)
  }

  const forCaller = async (): Promise<string | null> =>
    requireLogin ? pickFor(null) : pickDefault(deps.usable())

  return {
    forSpec: (computerId) =>
      computerId != null ? computerId : requireLogin ? null : pickDefault(deps.usable()),
    forTask,
    forProject,
    forCaller,
    async forTarget({ computerId, taskId, projectId }) {
      // An id the user explicitly chose wins — the create-project flow picks a
      // computer before any task or project row exists to resolve from.
      if (computerId != null) {
        if (requireLogin) {
          await admit(
            computerId,
            taskId != null
              ? resource('task', taskId)
              : projectId != null
                ? resource('project', projectId)
                : null
          )
        }
        return computerId
      }
      if (taskId != null) return forTask(taskId)
      if (projectId != null) {
        if (!requireLogin) return forProject(projectId)
        // A project with none of its owner's computers: theirs to bind, not the hub's
        // disk to browse in its place.
        const id = await forProject(projectId)
        if (id === null) throw new BindComputerError(`project ${projectId}`)
        return id
      }
      return forCaller()
    },
    gate: requireLogin
      ? async (computerId: string, work: ComputerWork) =>
          admit(computerId, work ? resource(work.kind, work.id) : null)
      : undefined,
    servesProject: async (computerId, projectId) =>
      !requireLogin || computerServes(db, true, computerId, resource('project', projectId))
  }
}
