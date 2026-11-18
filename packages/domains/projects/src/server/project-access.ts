import type { SlayzoneDb } from '@slayzone/platform'

/**
 * "May principal P access project X?" — the ONE place that answers it (T-16).
 * Every resource check goes through it: `canAccess` (transport `server/access.ts`)
 * resolves a task, tab, session … to its project and asks this. Enforced on tRPC
 * (T-17); REST and MCP (T-18) call the same `canAccess`.
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
 * `mayAccessProject` is that OWNER rule — still the whole rule for what lives on a
 * computer or a disk (paths, terminals, worktrees). Sharing (T-100) adds
 * {@link accessRoleOf}: the same rule extended to "owner, or a member / grantee, with
 * a role", for hub-resident content only.
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

// ── roles (T-100) ─────────────────────────────────────────────────────────────

/**
 * What a principal may do with SHARED, hub-resident content (a project's tasks,
 * artifacts, tags …). Ordered: each includes the one before.
 *
 *   view    read it.
 *   edit    change it, and start its agents on one's OWN computer.
 *   manage  also decide who else gets in (members, grants, visibility).
 *
 * Never consulted for computer-resident things (terminals, chats, worktrees,
 * processes, paths) or computers: those stay with their one owner
 * ({@link mayAccessProject}).
 */
export type AccessRole = 'view' | 'edit' | 'manage'

export const ACCESS_ROLES: readonly AccessRole[] = ['view', 'edit', 'manage']

const RANK: Record<AccessRole, number> = { view: 1, edit: 2, manage: 3 }

export function roleAtLeast(role: AccessRole | null, need: AccessRole): boolean {
  return role !== null && RANK[role] >= RANK[need]
}

export function maxRole(a: AccessRole | null, b: AccessRole | null): AccessRole | null {
  if (a === null) return b
  if (b === null) return a
  return RANK[a] >= RANK[b] ? a : b
}

/** One user's role on one thing (a `project_members` / `task_grants` row). */
export interface AccessGrant {
  readonly user_id: string
  readonly role: AccessRole
}

/**
 * The sharing facts of one thing: the user who owns it (manage) and the users it is
 * shared with. Resolution (`access.ts`) builds these per resource kind; this is the
 * one rule that reads them.
 */
export interface SharedOwnership extends ProjectOwnership {
  readonly grants?: readonly AccessGrant[]
}

/**
 * The principal's role, or null for none. No login: manage (the desktop app's hub has
 * one trusted operator). Login without a principal: none. Otherwise the owner manages
 * and a grantee gets its highest grant. An admin is no exception (O-6).
 */
export function accessRoleOf(req: ProjectAccessRequest, facts: SharedOwnership): AccessRole | null {
  if (!req.authRequired) return 'manage'
  if (!req.principal) return null
  const userId = req.principal.userId
  if (facts.owner_user_id !== null && facts.owner_user_id === userId) return 'manage'
  let role: AccessRole | null = null
  for (const g of facts.grants ?? []) if (g.user_id === userId) role = maxRole(role, g.role)
  return role
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
