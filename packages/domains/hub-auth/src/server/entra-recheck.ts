/**
 * The Entra re-check (T-12, O-8): on a hub with Entra sign-in, every signed-in account
 * is asked about again, by redeeming the refresh token its last sign-in left on its
 * `account` row (T-09 stores it encrypted). The hub schedules {@link EntraRecheck.run}
 * hourly (`sso-recheck.ts` there); this module is one pass.
 *
 * WHO. Every Entra account row with a refresh token whose user exists, is not disabled
 * (disabling already revoked everything) and holds a live session — a better-auth one,
 * or one outside hub-auth that the caller reports (`hasExternalSession`: the hub's web
 * sessions). An account nobody is signed in to is not asked: there is nothing to end,
 * and its next sign-in runs every check anyway.
 *
 * WHAT ENTRA'S ANSWER DOES. Only a DEFINITE refusal ends sessions; anything else keeps
 * them, so an Entra outage, a network fault or a hub-side problem never signs anyone out:
 *
 *   answer                                              action
 *   ─────────────────────────────────────────────────── ───────────────────────────────
 *   tokens; ID token verified, holds an app role        keep; role := the app role; the
 *                                                       rotated refresh token is stored
 *   tokens; verified ID token, no `roles` claim at all  keep; role unchanged (entra.ts
 *                                                       `evaluateRefreshedIdToken`: no
 *                                                       information, never a refusal)
 *   tokens; verified `roles` holds neither app role     REVOKE (`unassigned`)
 *   4xx `invalid_grant` (user disabled or deleted,      REVOKE (the OAuth error code)
 *     token revoked or expired, password changed),
 *     `interaction_required`, `consent_required`
 *   any other 4xx (`invalid_client`: the hub's         keep (`entra_error`)
 *     certificate, clock or registration)
 *   429, 5xx, timeout, network error                    keep (`entra_unavailable`)
 *   ID token that does not verify (a key-set fetch     keep (`id_token_untrusted`)
 *     failure lands here too), other tenant, other
 *     subject
 *   stored refresh token cannot be decrypted            keep (`token_unreadable`)
 *
 * REVOKE = the account's SESSIONS end: its better-auth sessions are deleted, then
 * `revokeExternal` ends the sessions it holds outside hub-auth (the hub: web sessions
 * and open sockets — not its computers, owner decision O-24; those go only when the
 * account is disabled in the hub). `disabledAt` is NOT set: Entra, not the hub, decides
 * whether the person may sign in again — a password change or a revoked grant ends the
 * old refresh token but not the person's access, and a person removed from the app
 * cannot sign in anyway (the sign-in checks run every time). A sign-in that replaced the refresh token while it was being asked wins: the
 * refusal was about the old token, so nothing is revoked.
 *
 * ROLE (O-4). The app role is the authority, as at sign-in (`syncEntraRole`), which has
 * no last-admin guard either: if the only admin loses `SlayZone.Admin` the account is
 * demoted and the line says `noAdminLeft`. On a hub with Entra sign-in that is
 * recoverable from Entra (assign the role; the next sign-in or re-check promotes),
 * unlike on a password hub, where the guard in users.ts exists because nothing could.
 *
 * AUDIT (`auth.sso.recheck`). A revocation: one `denied` line per account. A pass that
 * kept sessions for a reason not seen in the previous pass: one `failure` line at level
 * `info` per reason, with how many accounts it hit — not one per account per hour; when
 * a pass is clean again, one `success` line saying since when it was not. A role change
 * is a `user.role_change` line (`reason: 'sso_recheck'`). Never a token, never an email.
 *
 * @module hub-auth/entra-recheck
 */
import { securityEvent } from '@slayzone/platform/security-log'
import type { AuthContext } from 'better-auth'
import { decryptOAuthToken, setTokenUtil } from 'better-auth/oauth2'
import type { HubRole } from '../shared/types'
import { isDisabled, readRole } from './account'
import type { HubAuth } from './auth'
import {
  ENTRA_PROVIDER_ID,
  type EntraFetch,
  type EntraSsoConfig,
  EntraTokenError,
  entraKeySet,
  evaluateRefreshedIdToken,
  refreshEntraTokens
} from './entra'
import { listHubUsers } from './users'

/** OAuth error codes that are Entra's answer about the ACCOUNT: the grant is gone. */
export const DEFINITE_REFUSALS: ReadonlySet<string> = new Set([
  'invalid_grant',
  'interaction_required',
  'consent_required'
])

/** One token request may take this long before it counts as "Entra unavailable". */
export const ENTRA_RECHECK_TIMEOUT_MS = 15_000

/** Upper bound on account rows read per pass (better-auth defaults an absent limit to 100). */
const ACCOUNT_LIMIT = 1000

/** Why a pass kept an account's sessions without an answer about the account. */
export type RecheckKeptReason =
  | 'entra_unavailable'
  | 'entra_error'
  | 'id_token_untrusted'
  | 'token_unreadable'
  | 'signed_in_meanwhile'
  | 'internal_error'

export type RecheckOutcome =
  | { userId: string; result: 'ok'; role: HubRole; roleChanged: boolean }
  | { userId: string; result: 'revoked'; reason: string }
  | { userId: string; result: 'kept'; reason: RecheckKeptReason; cause: string }

export interface RecheckReport {
  /** Accounts asked about. */
  checked: number
  outcomes: RecheckOutcome[]
}

export interface EntraRecheckOptions {
  cfg: EntraSsoConfig
  /** Test seam: the token endpoint and the key set are reached through it. */
  fetch?: EntraFetch
  timeoutMs?: number
  now?: () => number
  /** True when the account holds a live session outside hub-auth (the hub's web sessions). */
  hasExternalSession?: (userId: string) => Promise<boolean>
  /** After a refusal deleted the account's better-auth sessions: end the sessions it
   *  holds outside hub-auth (the hub: web sessions and open sockets, not computers). */
  revokeExternal?: (userId: string) => Promise<unknown>
  /** After a role change: whatever captured the old role must re-read it (the hub
   *  closes the account's open sockets, which resolved their role when they opened). */
  onRoleChange?: (userId: string, role: HubRole) => unknown
  log?: (message: string) => void
}

export interface EntraRecheck {
  /** One pass over every signed-in Entra account. Never rejects. */
  run(): Promise<RecheckReport>
}

interface AccountRow {
  id: string
  userId: string
  accountId: string
  providerId: string
  refreshToken?: string | null
}

type Answer =
  | { kind: 'tokens'; refreshToken: string | undefined; idToken: string | undefined }
  | { kind: 'refused'; reason: string; aadsts: string | null }
  | { kind: 'kept'; reason: RecheckKeptReason; cause: string; aadsts?: string | null }

/** Sort a failed token request into a refusal about the account, or not (see the table). */
function classify(err: unknown): Answer {
  if (err instanceof EntraTokenError) {
    if (err.status >= 400 && err.status < 500 && DEFINITE_REFUSALS.has(err.code)) {
      return { kind: 'refused', reason: err.code, aadsts: err.aadsts }
    }
    if (err.status === 429 || err.status >= 500) {
      return {
        kind: 'kept',
        reason: 'entra_unavailable',
        cause: `http_${err.status}`,
        aadsts: err.aadsts
      }
    }
    return { kind: 'kept', reason: 'entra_error', cause: err.code, aadsts: err.aadsts }
  }
  const name = (err as { name?: unknown } | null)?.name
  const cause = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network'
  return { kind: 'kept', reason: 'entra_unavailable', cause }
}

export function createEntraRecheck(auth: HubAuth, opts: EntraRecheckOptions): EntraRecheck {
  const { cfg } = opts
  const now = opts.now ?? Date.now
  const timeoutMs = opts.timeoutMs ?? ENTRA_RECHECK_TIMEOUT_MS
  const keys = entraKeySet(cfg, opts.fetch)
  const log = opts.log ?? ((m: string) => console.log(m))
  /** Reasons the previous pass kept sessions for, and since when they have been seen. */
  let degraded: { since: number; reasons: Set<string> } | null = null

  async function hasLiveSession(userId: string): Promise<boolean> {
    const ctx = await auth.$context
    const sessions = await ctx.internalAdapter.listSessions(userId, { onlyActiveSessions: true })
    if (sessions.some((s) => new Date(s.expiresAt).getTime() > now())) return true
    return (await opts.hasExternalSession?.(userId)) === true
  }

  /** Revoke as disabling does, minus `disabledAt` (see the module note). */
  async function revoke(
    account: AccountRow,
    storedToken: string,
    reason: string,
    aadsts: string | null
  ): Promise<RecheckOutcome> {
    const ctx = await auth.$context
    const current = (await ctx.internalAdapter.findAccountByProviderId(
      account.accountId,
      ENTRA_PROVIDER_ID
    )) as AccountRow | null
    if (current && current.refreshToken !== storedToken) {
      return {
        userId: account.userId,
        result: 'kept',
        reason: 'signed_in_meanwhile',
        cause: reason
      }
    }
    await ctx.internalAdapter.deleteUserSessions(account.userId)
    let external = 'ok'
    try {
      await opts.revokeExternal?.(account.userId)
    } catch (err) {
      external = 'failed'
      log(
        `[entra-recheck] revoking sessions outside hub-auth failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    securityEvent({
      event: 'auth.sso.recheck',
      outcome: 'denied',
      actor: null,
      targetKind: 'user',
      targetId: account.userId,
      detail: { reason, aadsts, ...(external === 'ok' ? {} : { external }) }
    })
    return { userId: account.userId, result: 'revoked', reason }
  }

  async function changeRole(userId: string, role: HubRole): Promise<void> {
    const ctx = await auth.$context
    await ctx.internalAdapter.updateUser(userId, { role })
    const noAdminLeft =
      role === 'user' &&
      !(await listHubUsers(auth)).some((u) => u.disabledAt === null && u.role === 'admin')
    securityEvent({
      event: 'user.role_change',
      outcome: 'success',
      level: noAdminLeft ? 'warn' : undefined,
      actor: null,
      targetKind: 'user',
      targetId: userId,
      detail: { reason: 'sso_recheck', role, ...(noAdminLeft ? { noAdminLeft: true } : {}) }
    })
    if (noAdminLeft) {
      log(
        '[entra-recheck] the hub has no enabled admin now: Entra removed the admin app role ' +
          'from the last one. Assign SlayZone.Admin in Entra; the next sign-in or re-check promotes.'
      )
    }
    try {
      await opts.onRoleChange?.(userId, role)
    } catch {
      // The role is written; a socket that keeps its old role closes at its next check.
    }
  }

  async function checkOne(
    account: AccountRow,
    user: Record<string, unknown>
  ): Promise<RecheckOutcome> {
    const ctx = await auth.$context
    // The instance's own context, typed for its options; the token helpers take the
    // plain one.
    const tokenCtx = ctx as unknown as AuthContext
    const stored = account.refreshToken as string
    let refreshToken: string
    try {
      refreshToken = await decryptOAuthToken(stored, tokenCtx)
    } catch {
      return {
        userId: account.userId,
        result: 'kept',
        reason: 'token_unreadable',
        cause: 'decrypt'
      } as const
    }

    let answer: Answer
    try {
      const tokens = await refreshEntraTokens(cfg, refreshToken, {
        fetch: opts.fetch,
        signal: AbortSignal.timeout(timeoutMs)
      })
      answer = { kind: 'tokens', refreshToken: tokens.refreshToken, idToken: tokens.idToken }
    } catch (err) {
      answer = classify(err)
    }
    if (answer.kind === 'refused') return revoke(account, stored, answer.reason, answer.aadsts)
    if (answer.kind === 'kept') {
      return {
        userId: account.userId,
        result: 'kept',
        reason: answer.reason,
        cause: answer.cause
      } as const
    }

    // Entra rotates refresh tokens: keep the new one, encrypted as at sign-in.
    let current = stored
    if (answer.refreshToken && answer.refreshToken !== refreshToken) {
      const encrypted = await setTokenUtil(answer.refreshToken, tokenCtx)
      if (encrypted) {
        await ctx.internalAdapter.updateAccount(account.id, { refreshToken: encrypted })
        current = encrypted
      }
    }
    const role = readRole(user.role)
    // No ID token: the grant still stands; nothing to read the role from.
    if (!answer.idToken) {
      return { userId: account.userId, result: 'ok', role, roleChanged: false } as const
    }
    const verdict = await evaluateRefreshedIdToken(cfg, answer.idToken, keys, account.accountId)
    if (!verdict.ok) {
      if (verdict.reason === 'unassigned') return revoke(account, current, 'unassigned', null)
      return {
        userId: account.userId,
        result: 'kept',
        reason: 'id_token_untrusted',
        cause: verdict.reason
      } as const
    }
    // No `roles` claim says nothing about the role (entra.ts, evaluateRefreshedIdToken).
    if (verdict.role === null || verdict.role === role) {
      return { userId: account.userId, result: 'ok', role, roleChanged: false } as const
    }
    await changeRole(account.userId, verdict.role)
    return { userId: account.userId, result: 'ok', role: verdict.role, roleChanged: true } as const
  }

  /** Audit what this pass kept sessions for — once per reason per outage (module note). */
  function auditKept(outcomes: RecheckOutcome[]): void {
    const kept = outcomes.filter(
      (o): o is Extract<RecheckOutcome, { result: 'kept' }> =>
        o.result === 'kept' && o.reason !== 'signed_in_meanwhile'
    )
    if (kept.length === 0) {
      if (degraded) {
        securityEvent({
          event: 'auth.sso.recheck',
          outcome: 'success',
          level: 'info',
          actor: null,
          targetKind: 'hub',
          targetId: null,
          detail: { reason: 'recovered', since: new Date(degraded.since).toISOString() }
        })
        log('[entra-recheck] Entra answers again; re-checks are back to normal')
        degraded = null
      }
      return
    }
    const byReason = new Map<string, typeof kept>()
    for (const o of kept) byReason.set(o.reason, [...(byReason.get(o.reason) ?? []), o])
    const seen = degraded?.reasons ?? new Set<string>()
    for (const [reason, list] of byReason) {
      if (seen.has(reason)) continue
      securityEvent({
        event: 'auth.sso.recheck',
        outcome: 'failure',
        level: 'info',
        actor: null,
        targetKind: 'hub',
        targetId: null,
        detail: { reason, cause: list[0]!.cause, accounts: list.length, sessionsKept: true }
      })
      log(
        `[entra-recheck] ${list.length} account(s) not re-checked (${reason}: ${list[0]!.cause}); ` +
          'their sessions are kept and asked about again next hour'
      )
    }
    degraded = { since: degraded?.since ?? now(), reasons: new Set(byReason.keys()) }
  }

  return {
    async run(): Promise<RecheckReport> {
      const outcomes: RecheckOutcome[] = []
      let checked = 0
      try {
        const ctx = await auth.$context
        const accounts = (await ctx.adapter.findMany({
          model: 'account',
          where: [{ field: 'providerId', value: ENTRA_PROVIDER_ID }],
          limit: ACCOUNT_LIMIT
        })) as AccountRow[]
        for (const account of accounts) {
          if (!account.refreshToken) continue
          try {
            const user = (await ctx.internalAdapter.findUserById(account.userId)) as Record<
              string,
              unknown
            > | null
            if (!user || isDisabled(user)) continue
            if (!(await hasLiveSession(account.userId))) continue
            checked++
            outcomes.push(await checkOne(account, user))
          } catch (err) {
            outcomes.push({
              userId: account.userId,
              result: 'kept',
              reason: 'internal_error',
              cause: err instanceof Error ? err.name : 'error'
            })
          }
        }
      } catch (err) {
        log(
          `[entra-recheck] pass failed, retried next hour: ${err instanceof Error ? err.message : String(err)}`
        )
        outcomes.push({ userId: '', result: 'kept', reason: 'internal_error', cause: 'pass' })
      }
      auditKept(outcomes)
      return { checked, outcomes }
    }
  }
}
