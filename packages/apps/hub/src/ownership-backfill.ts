/**
 * Boot step: give the hub's unowned data to its first admin (T-16).
 *
 * `projects.owner_user_id` (migration v169) is NULL on every project that existed
 * before ownership, and on every project created while the hub ran without login
 * (no user on the request). The migration cannot fill it — the users live in the
 * auth database — so this does, on every boot of a hub that REQUIRES login:
 *
 *   - unowned projects → the first admin (`findFirstAdmin`: the oldest enabled
 *     admin, i.e. the person who ran the hub before it had users);
 *   - `user`-scoped rows of the global `settings` table (that person's open tabs,
 *     layout, filters) → the same admin's `user_settings`.
 *
 * Nothing is deleted or hidden: every project stays, now with an owner, and the
 * settings move rather than vanish. Idempotent — after the first run there is
 * nothing left to assign, and later runs change nothing and log nothing. One
 * `project.owner.backfill` audit line when anything changed, with the counts.
 *
 * A hub WITHOUT login (the desktop app's) is left alone: no request carries a user
 * there, ownership is never consulted (`mayAccessProject`), and its projects stay
 * NULL until login is turned on — at which boot this assigns them.
 *
 * Runs in `startServer` after the accounts are settled (`createHubAuth`'s
 * `ensureFirstAdmin`, then `ensureBootstrapOwner`) and before the hub listens, so
 * no request ever sees a project without an owner on a login hub.
 *
 * @module server/ownership-backfill
 */
import { findFirstAdmin, type HubAuth } from '@slayzone/hub-auth/server'
import type { SlayzoneDb } from '@slayzone/platform'
import { securityEvent } from '@slayzone/platform/security-log'
import { assignUnownedProjects } from '@slayzone/projects/server'
import { adoptLegacyUserSettings } from '@slayzone/settings/server'

export interface OwnershipBackfillResult {
  /** Who received the data, or null when the hub has no admin yet. */
  ownerUserId: string | null
  /** Projects that got an owner. */
  projects: number
  /** Settings keys moved from the global table to the owner. */
  settings: number
}

export async function backfillOwnership(opts: {
  db: SlayzoneDb
  hubAuth: HubAuth | null
  /** The `SLAYZONE_HUB_REQUIRE_LOGIN` switch. Off → nothing to do. */
  requireLogin: boolean
  log?: (message: string) => void
}): Promise<OwnershipBackfillResult | null> {
  const { db, hubAuth, log } = opts
  // `assertAuthLoaded` (B11) refuses a login hub whose auth failed, so a null
  // hubAuth here means login is off.
  if (!opts.requireLogin || !hubAuth) return null

  const owner = await findFirstAdmin(hubAuth)
  if (!owner) {
    // Only reachable with no human account at all (the bootstrap owner failed).
    // Nothing is lost by waiting: unowned projects are refused to everyone, not
    // shown to everyone, and the first boot with an admin assigns them.
    const row = await db.get<{ n: number }>(
      'SELECT count(*) AS n FROM projects WHERE owner_user_id IS NULL'
    )
    if ((row?.n ?? 0) > 0) {
      log?.(
        `[ownership] ${row!.n} project(s) have no owner and this hub has no admin yet; ` +
          'they go to the first admin at the next boot that has one'
      )
    }
    return { ownerUserId: null, projects: 0, settings: 0 }
  }

  const projects = await assignUnownedProjects(db, owner)
  const settings = await adoptLegacyUserSettings(db, owner)
  if (projects > 0 || settings > 0) {
    securityEvent({
      event: 'project.owner.backfill',
      outcome: 'success',
      actor: null,
      targetKind: 'user',
      targetId: owner,
      detail: { projectCount: projects, settingCount: settings }
    })
    log?.(
      `[ownership] assigned ${projects} unowned project(s) and ${settings} setting(s) to the first admin`
    )
  }
  return { ownerUserId: owner, projects, settings }
}
