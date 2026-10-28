/**
 * Computers on a hub with login (T-19): who may see, manage and use one, and whom a
 * computer may work for. Every decision is T-17's `canAccess` on the `computer`
 * resource (its owner, nobody else) — this module only adds the admin's MANAGEMENT
 * view on top, so there is still one access function.
 *
 *   use     bind a task or project to it, spawn on it, browse its files, change its
 *           allowed roots: its owner only (`canAccess` computer). An admin is no
 *           exception — that would be code execution in someone else's account (O-6).
 *   manage  see it in a list (metadata only), rename, revoke, delete: its owner or an
 *           admin. Un-revoking is the admin's alone (`computers.unrevoke`).
 *   serve   the work a computer does — a task's agent, a project's warm agent — must
 *           be its OWNER's: `canAccess` asked as the computer's owner about that task
 *           or project. Not just "visible to the caller": a caller acting on their own
 *           task still cannot have it run on a computer that belongs to someone else.
 *
 * An unowned computer (enrolled with a token nobody was recorded minting, e.g. on a
 * hub that ran without login) is visible to admins only and serves nobody: the hub
 * cannot know whose machine it is, and giving it to the first admin or the first
 * claimant would hand one of them a shell in an account that may not be theirs. The
 * fix is a re-enroll with a token minted for its owner.
 *
 * Without login (the desktop app's hub) every answer is yes, before any query.
 *
 * @module api/computer-access
 */
import type { SlayzoneDb } from '@slayzone/platform'
import { canAccess, resource, type AccessRequest, type OwnedResource } from './access'
import type { PrincipalRole } from './context'

/** A request that may MANAGE computers: the facts `canAccess` needs, plus the role. */
export interface ComputerManagerRequest extends AccessRequest {
  readonly role?: PrincipalRole | null
}

/** Whether the request may use this computer: bind work to it, browse it. Owner only. */
export function mayUseComputer(
  db: SlayzoneDb,
  req: AccessRequest,
  computerId: string
): Promise<boolean> {
  return canAccess(db, req, resource('computer', computerId))
}

/**
 * Whether the request may manage this computer: its owner, or an admin (who sees
 * every existing computer, unowned ones included, for management only).
 */
export async function mayManageComputer(
  db: SlayzoneDb,
  req: ComputerManagerRequest,
  computerId: string
): Promise<boolean> {
  if (!req.authRequired) return true
  if (!req.principal) return false
  if (req.role === 'admin') {
    return (await db.get('SELECT 1 FROM computers WHERE id = ?', [computerId])) !== undefined
  }
  return mayUseComputer(db, req, computerId)
}

/** The rows of a computer list this request may see (management view). */
export async function filterManagedComputers<T extends { id: string }>(
  db: SlayzoneDb,
  req: ComputerManagerRequest,
  rows: readonly T[]
): Promise<T[]> {
  if (!req.authRequired) return [...rows]
  if (!req.principal) return []
  if (req.role === 'admin') return [...rows]
  const out: T[] = []
  for (const row of rows) if (await mayUseComputer(db, req, row.id)) out.push(row)
  return out
}

/** Who owns a computer; null when unowned or missing. */
export async function computerOwnerOf(db: SlayzoneDb, computerId: string): Promise<string | null> {
  const row = await db.get<{ owner_user_id: string | null }>(
    'SELECT owner_user_id FROM computers WHERE id = ?',
    [computerId]
  )
  return row?.owner_user_id ?? null
}

/**
 * Whether this computer may do `work` (a task, a project, an agent session): may its
 * OWNER access that resource? An unowned computer serves nothing on a hub with login.
 */
export async function computerServes(
  db: SlayzoneDb,
  authRequired: boolean,
  computerId: string,
  work: OwnedResource
): Promise<boolean> {
  if (!authRequired) return true
  const owner = await computerOwnerOf(db, computerId)
  return canAccess(db, { authRequired, principal: owner ? { userId: owner } : null }, work)
}
