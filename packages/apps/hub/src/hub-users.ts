/**
 * The `hubUsers` capability behind `/api/hub/users` (`slay hub users …`): hub-auth's
 * account functions (`@slayzone/hub-auth/server` users.ts), plus what hub-auth cannot
 * reach itself when an account is disabled — its web sessions, open `/trpc` sockets and
 * computers (user-access.ts, T-12).
 *
 * `getAuth` is read per call: hub-auth is built asynchronously after the REST deps
 * (see the composition root), and stays null forever if its init threw. `ready()`
 * reports exactly that.
 *
 * Also the account lookup a join-token mint names its owner with (T-20,
 * {@link createJoinTokenAccountLookup}).
 *
 * @module hub/hub-users
 */
import {
  createHubUser,
  disableHubUser,
  enableHubUser,
  findHubUser,
  listHubUsers,
  setHubUserRole,
  type HubAuth
} from '@slayzone/hub-auth/server'
import type { ComputersDeps, RestApiDeps } from '@slayzone/transport/server'
import type { UserAccessRevoker } from './user-access.js'

export function createHubUsersCapability(
  getAuth: () => HubAuth | null,
  revoker: Pick<UserAccessRevoker, 'revokeUser'>
): NonNullable<RestApiDeps['hubUsers']> {
  return {
    ready: () => getAuth() !== null,
    create: async (input) => {
      // Unreachable in practice — the route checks `ready()` first — but this must
      // not silently no-op if that order ever changes.
      const auth = getAuth()
      if (!auth) throw new Error('hub-auth is not ready')
      const created = await createHubUser(auth, input)
      return 'error' in created
        ? { ok: false as const, reason: created.error }
        : { ok: true as const, user: created }
    },
    list: async () => {
      const auth = getAuth()
      return auth ? listHubUsers(auth) : []
    },
    disable: async (email) => {
      const auth = getAuth()
      if (!auth) return 'not-found'
      return disableHubUser(auth, email, {
        revokeExternalSessions: (userId) => revoker.revokeUser(userId)
      })
    },
    enable: async (email) => {
      const auth = getAuth()
      return auth ? enableHubUser(auth, email) : 'not-found'
    },
    setRole: async (email, role) => {
      const auth = getAuth()
      return auth ? setHubUserRole(auth, email, role) : 'not-found'
    }
  }
}

/**
 * The person a join token is minted for (T-20, transport `join-token-policy.ts`): an
 * account id or email, a person only (never the computer service user or a
 * break-glass account — `findHubUser`). Throws while hub-auth is not loaded rather
 * than answering "no such user": on a hub with login the server does not serve until
 * it is (B11), so this is a fault, not an answer.
 */
export function createJoinTokenAccountLookup(
  getAuth: () => HubAuth | null
): NonNullable<ComputersDeps['findAccount']> {
  return async (ref) => {
    const auth = getAuth()
    if (!auth) throw new Error('hub accounts are not loaded')
    const user = await findHubUser(auth, ref)
    return user ? { userId: user.id, disabled: user.disabledAt !== null } : null
  }
}
