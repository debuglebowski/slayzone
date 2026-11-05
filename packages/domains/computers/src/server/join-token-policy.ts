/**
 * Who a join token is for, and for how long (T-20, owner decision O-5). One decision
 * for both mint surfaces, `computers.mintJoinToken` (tRPC) and
 * `POST /api/computers/join-token` (REST), so they cannot drift.
 *
 * WHO MAY MINT is decided before this: on a hub with login any signed-in user, never
 * a break-glass session (hub `rest-auth.ts`, `hub-trpc-context.ts`). This decides
 * WHO the token is FOR:
 *
 *   - On a hub with login: a computer is personal (`visibility.ts`: its owner uses it,
 *     nobody else), so enrolling one's OWN computer is every user's to do. Naming
 *     nobody, or naming yourself, mints a token for the caller. Naming ANYONE ELSE is
 *     an admin's alone, and must name an account that exists and is enabled; a
 *     non-admin gets the same refusal for an unknown name as for someone else's, so
 *     the mint cannot probe which accounts exist. The owner gets the computer that
 *     redeems the token, whoever redeems it; the minter is only the audit line's
 *     actor.
 *   - On a hub without login (the desktop app's): unchanged. Anyone on the box
 *     mints, for nobody: the computer is unowned, as before. Naming a user there is
 *     refused rather than ignored — there are no accounts to check it against, and
 *     a silently unowned computer is not what the caller asked for.
 *   - Everywhere: a lifetime of at most 1 hour (`MAX_JOIN_TOKEN_TTL_MS`); a longer
 *     one is refused, never clipped. Default 15 minutes.
 *
 * Each refusal has a stable code and writes one `computer.join_token.mint` line,
 * `denied`, with the code as `detail.reason`. The reference the caller typed is
 * never written (it may be an email); a resolved account id is.
 *
 * @module computers/server/join-token-policy
 */
import {
  DEFAULT_JOIN_TOKEN_TTL_MS,
  JOIN_TOKEN_TTL_TOO_LONG,
  MAX_JOIN_TOKEN_TTL_MS
} from './join-tokens'
import { securityEvent } from '@slayzone/platform/security-log'
import { registerAppCode } from '@slayzone/trpc-server'

export { DEFAULT_JOIN_TOKEN_TTL_MS, JOIN_TOKEN_TTL_TOO_LONG, MAX_JOIN_TOKEN_TTL_MS }

/** A hub with login, no user named, and no signed-in user to default to. */
export const JOIN_TOKEN_OWNER_REQUIRED = 'JOIN_TOKEN_OWNER_REQUIRED'
/** A non-admin named someone other than themselves. */
export const JOIN_TOKEN_OWNER_FORBIDDEN = 'JOIN_TOKEN_OWNER_FORBIDDEN'
/** The named user does not exist (or is not a person: the service or break-glass account). */
export const JOIN_TOKEN_OWNER_UNKNOWN = 'JOIN_TOKEN_OWNER_UNKNOWN'
/** The named user's account is disabled. */
export const JOIN_TOKEN_OWNER_DISABLED = 'JOIN_TOKEN_OWNER_DISABLED'
/** A user named on a hub without login. */
export const JOIN_TOKEN_OWNER_UNSUPPORTED = 'JOIN_TOKEN_OWNER_UNSUPPORTED'

export type JoinTokenRefusalCode =
  | typeof JOIN_TOKEN_TTL_TOO_LONG
  | typeof JOIN_TOKEN_OWNER_REQUIRED
  | typeof JOIN_TOKEN_OWNER_FORBIDDEN
  | typeof JOIN_TOKEN_OWNER_UNKNOWN
  | typeof JOIN_TOKEN_OWNER_DISABLED
  | typeof JOIN_TOKEN_OWNER_UNSUPPORTED

/** The account a join token can be for, as the hub's account store reports it. */
export interface JoinTokenAccount {
  userId: string
  disabled: boolean
}

/**
 * The person `ref` names: an account id or an email. Null for no such person.
 * Throws when the account store is not available (hub-auth not loaded yet).
 */
export type FindJoinTokenAccount = (ref: string) => Promise<JoinTokenAccount | null>

/** The cause of a refused mint; tRPC's error formatter turns it into `data.appCode`. */
export class JoinTokenRefusedError extends Error {
  constructor(
    readonly code: JoinTokenRefusalCode,
    message: string
  ) {
    super(message)
    this.name = 'JoinTokenRefusedError'
  }
}

/** `instanceof`, plus a structural fallback for an error from another module copy. */
export function isJoinTokenRefusedError(err: unknown): err is JoinTokenRefusedError {
  if (err instanceof JoinTokenRefusedError) return true
  return (
    err instanceof Error &&
    err.name === 'JoinTokenRefusedError' &&
    typeof (err as { code?: unknown }).code === 'string'
  )
}

// tRPC's error formatter (`@slayzone/trpc-server`) carries the code as `data.appCode`.
// Registered here, where the error is defined: it is registered whenever one can be thrown.
registerAppCode((cause) => (isJoinTokenRefusedError(cause) ? cause.code : undefined))

export type JoinTokenMintDecision =
  | { ok: true; ownerUserId: string | null; ttlMs: number }
  | { ok: false; error: JoinTokenRefusedError }

const MAX_MINUTES = MAX_JOIN_TOKEN_TTL_MS / 60_000

/** Whether a refusal is the caller's lack of authority (403) rather than a bad request. */
export function isJoinTokenForbidden(code: JoinTokenRefusalCode): boolean {
  return code === JOIN_TOKEN_OWNER_FORBIDDEN
}

/**
 * Decide a mint, auditing a refusal. Call inside the request's security context, so
 * the line carries the minter, client address and route.
 *
 * `ttlMs` is a positive whole number of ms, or undefined for the default; the
 * surfaces validate its shape. `forUser` blank = no user named.
 */
export async function decideJoinTokenMint(input: {
  loginRequired: boolean
  forUser: string | undefined
  ttlMs: number | undefined
  /**
   * The signed-in caller: who a token naming nobody is for, and whether they may
   * name someone else. Null on a hub without login.
   */
  caller: { userId: string; isAdmin: boolean } | null
  /** Absent on a hub without login. Required, and called, only on one with login. */
  findAccount: FindJoinTokenAccount | undefined
}): Promise<JoinTokenMintDecision> {
  const ttlMs = input.ttlMs ?? DEFAULT_JOIN_TOKEN_TTL_MS
  const forUser = input.forUser?.trim() || undefined
  const refuse = (
    code: JoinTokenRefusalCode,
    message: string,
    owner?: string
  ): JoinTokenMintDecision => {
    securityEvent({
      event: 'computer.join_token.mint',
      outcome: 'denied',
      targetKind: 'join_token',
      targetId: null,
      detail: { reason: code, ttlMs, ...(owner ? { owner } : {}) }
    })
    return { ok: false, error: new JoinTokenRefusedError(code, message) }
  }

  if (ttlMs > MAX_JOIN_TOKEN_TTL_MS) {
    return refuse(
      JOIN_TOKEN_TTL_TOO_LONG,
      `a join token lives at most ${MAX_MINUTES} minutes; ask for ${MAX_MINUTES} or less`
    )
  }
  if (!input.loginRequired) {
    if (forUser) {
      return refuse(
        JOIN_TOKEN_OWNER_UNSUPPORTED,
        'this hub has no login, so a computer cannot be enrolled for a named user; ' +
          'mint without one'
      )
    }
    return { ok: true, ownerUserId: null, ttlMs }
  }
  const caller = input.caller
  if (!forUser) {
    if (caller) return { ok: true, ownerUserId: caller.userId, ttlMs }
    return refuse(
      JOIN_TOKEN_OWNER_REQUIRED,
      'name the user this computer is for: on a hub with login every computer is ' +
        'enrolled for a named user, who becomes its owner (their email or account id)'
    )
  }
  if (!input.findAccount) throw new Error('this hub cannot look up accounts yet; try again')
  const account = await input.findAccount(forUser)
  if (caller && !caller.isAdmin && account?.userId !== caller.userId) {
    return refuse(
      JOIN_TOKEN_OWNER_FORBIDDEN,
      'you can enroll computers only for yourself; ask a hub admin to enroll one for ' +
        'someone else'
    )
  }
  if (!account) return refuse(JOIN_TOKEN_OWNER_UNKNOWN, 'no such user on this hub')
  if (account.disabled) {
    return refuse(JOIN_TOKEN_OWNER_DISABLED, "that user's account is disabled", account.userId)
  }
  return { ok: true, ownerUserId: account.userId, ttlMs }
}
