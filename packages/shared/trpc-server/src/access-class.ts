/**
 * The account-role vocabulary of the role gate (T-15). The per-surface TABLES that
 * classify every procedure, route and tool are composition data and live in
 * `@slayzone/api`'s `admin-policy.ts`; the tRPC gate reaches its table through the
 * registered `ProcedurePolicy.adminClassOf` (`procedure-policy.ts`).
 *
 *   admin — a non-admin account is refused, with the stable code {@link ADMIN_ONLY}.
 *   user  — any signed-in account.
 *   open  — reachable with no session at all on a hub that requires login
 *           (descriptive only: openness comes from `openProcedure`).
 *
 * @module trpc-server/access-class
 */
import type { PrincipalRole } from './context'

export type AccessClass = 'admin' | 'user' | 'open'

/** The stable refusal code, on every surface. */
export const ADMIN_ONLY = 'ADMIN_ONLY'

/**
 * Whether an account with `role` may call an item of class `cls`. An admin may call
 * anything. `undefined` (unclassified) needs an admin: fail closed.
 */
export function roleAllows(cls: AccessClass | undefined, role: PrincipalRole): boolean {
  if (role === 'admin') return true
  return cls === 'user' || cls === 'open'
}
