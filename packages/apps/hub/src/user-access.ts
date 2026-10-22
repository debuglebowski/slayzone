/**
 * Ending an account's access outside hub-auth (T-12) — the half that hub-auth cannot
 * reach, because it lives in the app DB and in this process. hub-auth deletes the
 * account's better-auth sessions itself and then calls one of these:
 *
 * DISABLED IN THE HUB (`disableHubUser`, break-glass close) — {@link
 * UserAccessRevoker.revokeUser}, everything, in order:
 *   1. its web sessions (`szw_`, `web_sessions`): revoked, rows kept;
 *   2. its open `/trpc` sockets: closed (trpc-connections.ts), since a socket keeps
 *      the principal it opened with;
 *   3. the computers it owns (`computers.owner_user_id`): REVOKED, and dropped if
 *      connected. Revoked rather than only disconnected: a computer runs as its owner's
 *      OS account, and a disconnected one dials straight back with a key that still
 *      verifies. Revoking is the existing, reversible state (`revoked_at`; rows,
 *      bindings and grants kept), shown in Settings → Computers, so an admin sees it
 *      and can re-invite. It also stays revoked if the account is enabled again, like
 *      every other credential here. `verifyApiKey` refuses a computer whose owner is
 *      disabled as well (computer-auth.ts) — the second line, for a row this missed.
 *
 * REFUSED BY ENTRA (the hourly re-check) — {@link UserAccessRevoker.endSessions}: steps
 * 1 and 2 only. The computers stay enrolled and connected (owner decision O-24): a
 * refusal also follows a Microsoft password change, after which the person signs in
 * again and finds their machines as they left them. A leaver loses their computers
 * when an admin disables them in the hub.
 *
 * Nothing is deleted. Each step is audited where it happens: `auth.web_session.revoke`
 * (web-sessions.ts) and one `computer.revoke` per computer here.
 *
 * @module hub/user-access
 */
import type { HubComputerGateway } from '@slayzone/computer-transport/server'
import { revokeComputer } from '@slayzone/computers/server'
import type { SlayzoneDb } from '@slayzone/platform'
import { securityEvent } from '@slayzone/platform/security-log'
import type { TrpcConnectionRegistry } from './trpc-connections.js'
import { revokeAllWebSessions } from './web-sessions.js'

export interface EndedSessions {
  webSessions: number
  sockets: number
}

export interface RevokedAccess extends EndedSessions {
  computers: number
}

export interface UserAccessRevoker {
  /** The account was disabled in the hub: sessions AND computers (see the module note). */
  revokeUser(userId: string): Promise<RevokedAccess>
  /** Entra refused the account: web sessions and sockets; computers untouched (O-24). */
  endSessions(userId: string): Promise<EndedSessions>
  /** Close the account's open sockets so they reconnect and re-read its role. */
  reconnectUser(userId: string): number
}

export function createUserAccessRevoker(deps: {
  db: SlayzoneDb
  /** Late-bound: the gateway exists once the async computer init has run. */
  getGateway: () => Pick<HubComputerGateway, 'disconnect'> | null
  connections: Pick<TrpcConnectionRegistry, 'closeUser'>
  log?: (message: string) => void
}): UserAccessRevoker {
  const log = deps.log ?? ((m: string) => console.log(m))

  const endSessions = async (userId: string): Promise<EndedSessions> => {
    const webSessions = await revokeAllWebSessions(deps.db, userId)
    const sockets = deps.connections.closeUser(userId, 'access revoked')
    return { webSessions, sockets }
  }

  return {
    async revokeUser(userId) {
      const { webSessions, sockets } = await endSessions(userId)
      const owned = await deps.db.all<{ id: string; revoked_at: number | null }>(
        `SELECT id, revoked_at FROM computers WHERE owner_user_id = ?`,
        [userId]
      )
      let computers = 0
      for (const computer of owned) {
        if (computer.revoked_at === null) {
          await revokeComputer(deps.db, computer.id)
          computers++
          securityEvent({
            event: 'computer.revoke',
            outcome: 'success',
            targetKind: 'computer',
            targetId: computer.id,
            detail: { reason: 'user_disabled', owner: userId }
          })
        }
        // Also an already-revoked one: revoking never dropped a live connection.
        deps.getGateway()?.disconnect(computer.id, 'owner access revoked')
      }
      if (webSessions + sockets + computers > 0) {
        log(
          `[user-access] account disabled: revoked ${webSessions} web session(s), closed ` +
            `${sockets} socket(s), revoked ${computers} computer(s)`
        )
      }
      return { webSessions, sockets, computers }
    },
    async endSessions(userId) {
      const ended = await endSessions(userId)
      if (ended.webSessions + ended.sockets > 0) {
        log(
          `[user-access] refused by Entra: revoked ${ended.webSessions} web session(s), ` +
            `closed ${ended.sockets} socket(s); computers kept`
        )
      }
      return ended
    },
    reconnectUser(userId) {
      return deps.connections.closeUser(userId, 'role changed')
    }
  }
}
