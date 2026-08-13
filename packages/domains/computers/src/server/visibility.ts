/**
 * Who may see and use a computer.
 *
 * A computer is one OS user's environment: its `$HOME`, its credentials, its
 * ptys. Binding a task to someone else's computer is therefore CODE EXECUTION in
 * that person's account — which is why this is enforced in the STORE and not in a
 * router. Every mutation that accepts a computer id goes through
 * {@link assertComputerVisible}; a check that lives one layer up is a check the
 * next caller forgets.
 *
 * The predicate, in one place so it cannot drift between the list and the guard:
 *
 *   unowned            — visible to everyone. Every row is unowned today (v161
 *                        deliberately did not backfill), and hiding them would
 *                        strand existing installs behind a claim nobody knows to
 *                        perform. `claimComputer` is how that ends.
 *   owner              — always
 *   visibility = 'hub' — any authenticated user on this hub
 *   explicit grant     — a row in `computer_grants`
 *   hub admin          — org-level role, not a notion invented here
 *
 * @module computers/server/visibility
 */

import type { SlayzoneDb } from '@slayzone/platform'

export interface ComputerViewer {
  /** Null = unauthenticated. Only reachable on a supervised hub, where the
   *  Electron host owns the process and there is exactly one user. */
  userId: string | null
  isHubAdmin?: boolean
}

/**
 * SQL fragment + params for "computers this viewer may see".
 *
 * Returned rather than inlined so the list query and the single-row guard are
 * literally the same predicate — the failure mode worth designing against is a
 * list that hides a computer while a mutation still accepts its id.
 */
export function visibilityClause(viewer: ComputerViewer): { sql: string; params: unknown[] } {
  // A supervised hub has no user identity and exactly one human; gating there
  // would break the desktop app for no gain.
  if (!viewer.userId) return { sql: '1 = 1', params: [] }
  if (viewer.isHubAdmin) return { sql: '1 = 1', params: [] }
  return {
    sql: `(
      owner_user_id IS NULL
      OR owner_user_id = ?
      OR visibility = 'hub'
      OR EXISTS (SELECT 1 FROM computer_grants g
                  WHERE g.computer_id = computers.id AND g.user_id = ?)
    )`,
    params: [viewer.userId, viewer.userId]
  }
}

export async function listVisibleComputerIds(
  db: SlayzoneDb,
  viewer: ComputerViewer
): Promise<Set<string>> {
  const { sql, params } = visibilityClause(viewer)
  const rows = await db.all<{ id: string }>(
    `SELECT id FROM computers WHERE revoked_at IS NULL AND ${sql}`,
    params
  )
  return new Set(rows.map((r) => r.id))
}

export async function isComputerVisible(
  db: SlayzoneDb,
  computerId: string,
  viewer: ComputerViewer
): Promise<boolean> {
  const { sql, params } = visibilityClause(viewer)
  const row = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM computers WHERE id = ? AND ${sql}`,
    [computerId, ...params]
  )
  return (row?.n ?? 0) > 0
}

/**
 * Throw unless this viewer may bind work to that computer.
 *
 * Deliberately the same message whether the computer is invisible or absent: the
 * difference would tell an unauthorized caller that a given id exists.
 */
export async function assertComputerVisible(
  db: SlayzoneDb,
  computerId: string | null,
  viewer: ComputerViewer
): Promise<void> {
  // null = "unbind", which needs no permission — it can only ever narrow.
  if (computerId === null) return
  if (!(await isComputerVisible(db, computerId, viewer))) {
    throw new Error('no such computer, or you do not have access to it')
  }
}

/** Take ownership of an unowned computer. Never reassigns an owned one. */
export async function claimComputer(
  db: SlayzoneDb,
  computerId: string,
  userId: string
): Promise<boolean> {
  const res = await db.run(
    `UPDATE computers SET owner_user_id = ? WHERE id = ? AND owner_user_id IS NULL`,
    [userId, computerId]
  )
  return ((res as { changes?: number })?.changes ?? 0) > 0
}

export async function setComputerVisibility(
  db: SlayzoneDb,
  computerId: string,
  visibility: 'private' | 'hub' | 'shared'
): Promise<void> {
  await db.run(`UPDATE computers SET visibility = ? WHERE id = ?`, [visibility, computerId])
}

export async function grantComputerAccess(
  db: SlayzoneDb,
  opts: {
    computerId: string
    userId: string
    grantedByUserId: string | null
    role?: 'use' | 'admin'
  }
): Promise<void> {
  await db.run(
    `INSERT INTO computer_grants (computer_id, user_id, role, granted_by_user_id, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(computer_id, user_id) DO UPDATE SET role = excluded.role`,
    [opts.computerId, opts.userId, opts.role ?? 'use', opts.grantedByUserId, Date.now()]
  )
}

export async function revokeComputerAccess(
  db: SlayzoneDb,
  computerId: string,
  userId: string
): Promise<void> {
  await db.run(`DELETE FROM computer_grants WHERE computer_id = ? AND user_id = ?`, [
    computerId,
    userId
  ])
}
