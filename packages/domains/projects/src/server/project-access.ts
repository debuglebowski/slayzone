import type { SlayzoneDb } from '@slayzone/platform'

/**
 * "May principal P access project X?" — the ONE place that answers it (T-16).
 * Not wired into any procedure yet: enforcement is T-17 (tRPC) / T-18 (REST, MCP),
 * which call this rather than re-deriving the rule.
 *
 * The rule, in order:
 *   1. A hub without login (`authRequired: false` — the desktop app's hub, a
 *      loopback hub) has one trusted local operator and no users. Ownership is not
 *      consulted: everything is accessible, exactly as before ownership existed.
 *   2. On a hub that requires login, no verified principal → no access.
 *   3. The owner has access. Nobody else does — an admin included: on this hub an
 *      admin manages accounts and computers, and cannot read content (O-6).
 *   4. A project with no owner is refused. The boot backfill gives every unowned
 *      project to the first admin before the hub listens
 *      (`apps/hub/src/ownership-backfill.ts`); one that is somehow still unowned is
 *      a gap to fix, not a project to show to every user.
 *
 * Sharing (T-100) extends rule 3 to "owner or member": add the membership facts to
 * {@link ProjectOwnership} and one clause below. Callers do not change.
 *
 * Where callers get `authRequired`: tRPC `getAuthGate()` (`@slayzone/transport`
 * app-deps), REST `deps.restAuth?.required() === true`. Both come from the
 * `SLAYZONE_HUB_REQUIRE_LOGIN` switch.
 */

/** Who is asking: `ctx.principal` (tRPC) or the bound REST principal fit as-is. */
export interface ProjectAccessPrincipal {
  readonly userId: string
}

export interface ProjectAccessRequest {
  /** Whether this hub requires login. */
  readonly authRequired: boolean
  /** The request's verified principal, or null when it carries none. */
  readonly principal: ProjectAccessPrincipal | null
}

/** The ownership facts of a project. `Project` and a raw `projects` row both fit. */
export interface ProjectOwnership {
  readonly owner_user_id: string | null
}

export function mayAccessProject(req: ProjectAccessRequest, project: ProjectOwnership): boolean {
  if (!req.authRequired) return true
  if (!req.principal) return false
  return project.owner_user_id !== null && project.owner_user_id === req.principal.userId
}

/** {@link mayAccessProject} for a project id. A project that does not exist: false. */
export async function mayAccessProjectId(
  db: SlayzoneDb,
  req: ProjectAccessRequest,
  projectId: string
): Promise<boolean> {
  const row = await db.get<ProjectOwnership>('SELECT owner_user_id FROM projects WHERE id = ?', [
    projectId
  ])
  return row !== undefined && mayAccessProject(req, row)
}
