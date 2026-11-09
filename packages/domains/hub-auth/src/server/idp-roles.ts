/**
 * The IdP-role mode (`IDP_ROLES_ENABLED=true`): every human account's hub role comes from
 * the identity provider, is re-proven at least once per recheck interval (≤ 3600 s), and
 * nothing inside the hub can change it. The POLICY is the shared contract
 * (`@normain/idp-role-contract` 0.1.0 — config parsing, claim resolution, freshness and
 * the OIDC revalidation flow, identical in Kahuna); this module is SlayZone's adapter:
 * storage, the per-request gate, activation epochs, revocation and audit.
 *
 * STORAGE (hub-auth's own sqlite file):
 *   - `user.idpSubject` / `idpVerifiedAt` / `idpRevision`: the identity's OIDC `sub`, the
 *     signed `iat` of the newest verified role evidence (Unix seconds), and a revision
 *     bumped by every write — the CAS fence of the contract.
 *   - `user.idpGrantedAt`: since when the account's current access stands (Unix ms) —
 *     set by a verified sign-in when the account had none, cleared by every revocation
 *     and activation. A session counts only if created at or after it: one that
 *     survived a revocation (a failed revoke outside hub-auth), or was issued late
 *     (a device or app code redeemed after the revocation), stays dead — also after the
 *     person's next valid sign-in.
 *   - `user.idpRevokedAt`: when the account last lost its access (Unix ms) — the
 *     revocation watermark. With the epoch's start it is the CUTOFF for sign-in
 *     evidence: a sign-in counts only if its ID token was signed in a later second
 *     (`iat` > floor(cutoff / 1000)), so a login or code exchange still pending when the
 *     mode was activated or the account was revoked can never complete into access.
 *     Seconds against milliseconds, conservatively: evidence signed in the SAME second
 *     as the cutoff is refused — a person signing in within one second of an activation
 *     or a revocation simply signs in again a second later.
 *   - `session.idpEpoch`: the activation epoch a session was created in.
 *   - `slayzone_idp_activation` (one row): the config identity the mode last ran with
 *     (`off`, or a hash of issuer, client, claim and mapping), its epoch and when it
 *     began. Written in ONE transaction with the invalidation it causes.
 *
 * ACTIVATION ({@link recordIdpActivation}, every boot, before the hub serves): turning the
 * mode on, or changing its role config, starts a new epoch and — in the same
 * transaction — ends every human session (better-auth sessions: cookies, CLI/desktop/app
 * bearers), deletes human API keys, and clears every human's role to `user` with no
 * verified evidence. The hub then revokes what lives outside this database (web
 * sessions). Booting again with the same config does nothing; turning the mode off is
 * recorded too, so off → on is a new epoch. Automation credentials (computer API keys,
 * owned by the service user) are untouched. The break-glass account is server
 * administration's recovery path and is never gated (./break-glass.ts).
 *
 * THE GATE ({@link IdpRoles.authorize}), at every human authenticated entry —
 * `verifySession` (REST, `/trpc`, CLI and app bearers, cookies) and the hub's web
 * sessions: the session must belong to the current epoch, and the account's evidence
 * must be fresh (contract `freshness`: signed `iat` + interval strictly in the future).
 * If it is not, the shared `revalidateOidc` runs inline: a refresh at the issuer, the new
 * ID token verified here (signature, issuer, audience, tenant, same account), and its
 * claims re-mapped. No new ID token, a failed verification, an older `iat`, a missing or
 * unmapped claim, a failed save: the request is refused and — unless a newer sign-in won
 * the race — the account loses its role, every session and every user credential, and
 * must sign in again. A periodic {@link IdpRoles.sweep} refreshes signed-in accounts
 * shortly before their deadline so the inline path is rarely taken, and the hub closes
 * `/trpc` sockets at each account's deadline unless re-proven (trpc-connections.ts).
 *
 * CONCURRENCY. A hub is one process: each identity's revalidation and sign-in run under
 * one per-identity lock covering the refresh request AND the save, so a rotated refresh
 * token is never redeemed twice. Inside the lock the state is re-read; every save is a
 * compare-and-set on (`idpRevision`, stored refresh token, epoch) in one SQLite
 * transaction. A sign-in that lands meanwhile changes the stored refresh token before it
 * takes the lock, so a stale refresh fails its CAS and is refused WITHOUT revoking the
 * newer sign-in.
 *
 * AUDIT: the contract's events (`idp_roles.*`, built by its `buildAuditEvent`) as
 * security-log lines — service `slayzone`, opaque actor and subject ids, static reasons.
 *
 * @module hub-auth/idp-roles
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  type AuditEvent,
  buildAuditEvent,
  freshness,
  type RevalidationReason,
  type RoleConfig,
  revalidateOidc
} from '@normain/idp-role-contract'
import { securityEvent } from '@slayzone/platform/security-log'
import type { AuthContext } from 'better-auth'
import { decryptOAuthToken, setTokenUtil } from 'better-auth/oauth2'
import type { HubRole } from '../shared/types'
import { BREAK_GLASS_EMAIL, isBreakGlassEmail, readRole } from './account'
import { COMPUTER_SERVICE_USER_EMAIL } from './computer-keys'
import {
  type EntraFetch,
  entraKeySet,
  highestHubRole,
  refreshEntraTokens,
  type SsoConfig,
  type SsoProvider,
  signedInAccount,
  ssoProvider,
  verifyIdTokenClaims
} from './entra'

/** `service` of every audit event this adapter writes. */
export const IDP_AUDIT_SERVICE = 'slayzone'

/** Opaque actor of decisions the identity provider made. */
const IDP_ACTOR = 'idp'

/** A refresh request may take this long before it counts as failed. */
export const IDP_REFRESH_TIMEOUT_MS = 15_000

/** The sweep refreshes an account this long (at most a quarter interval) before its deadline. */
export const IDP_SWEEP_MARGIN_SEC = 300

/** Error code of a request refused because the account must sign in again. */
export const IDP_REVALIDATION_REQUIRED = 'IDP_REVALIDATION_REQUIRED'

/**
 * ISSUANCE BINDING. In the mode, a session that is not itself an SSO sign-in — the
 * iOS app's code exchange (app-sign-in.ts), a device code's token (device.ts), anything
 * else that mints one — must say which SSO authentication approved it: `authAtMs`, when
 * that authentication's browser session was created. It is issued only if the account
 * holds access granted at or before that moment ({@link IdpRoles.authorizeIssuance}). A
 * code approved before a revocation or an activation therefore never mints a session —
 * also after the person's next valid sign-in re-grants access. A session minted with no
 * binding is refused (fail closed).
 */
const issuance = new AsyncLocalStorage<{ authAtMs: number }>()

/** Run `fn` (which creates a session) bound to the SSO authentication that approved it. */
export function withIssuanceBinding<T>(
  binding: { authAtMs: number },
  fn: () => Promise<T>
): Promise<T> {
  return issuance.run(binding, fn)
}

/** Thrown out of a fenced write when a newer sign-in or epoch won. */
class SupersededError extends Error {
  constructor() {
    super('[hub-auth] IdP role state changed meanwhile')
    this.name = 'SupersededError'
  }
}

/**
 * Persisted-mode fence (every instance, mode on or off): what THIS process believes the
 * mode is, compared on every authenticated request with what the database says. A
 * process still running with the mode off while another boot activated it — or one
 * running an older config or epoch — authorizes nothing.
 */
interface ModeFence {
  db: DatabaseSync
  /** {@link idpConfigIdentity}, or null with the mode off. */
  identity: string | null
  epoch: number | null
}

const fences = new WeakMap<object, ModeFence>()

/** Register an instance's local view of the mode (auth.ts, at boot). */
export function setIdpModeFence(auth: object, fence: ModeFence): void {
  fences.set(auth, fence)
}

/** True when the persisted mode is this process's: both off, or the same config and epoch. */
export function idpModeFenceOk(auth: object): boolean {
  const fence = fences.get(auth)
  if (!fence) return true // an instance this module never saw (tests of other modules)
  return persistedMatches(fence.db, fence.identity, fence.epoch)
}

function persistedMatches(
  db: DatabaseSync,
  identity: string | null,
  epoch: number | null
): boolean {
  try {
    db.exec(ACTIVATION_DDL)
    const row = db
      .prepare('SELECT config_identity, epoch FROM slayzone_idp_activation WHERE id = 1')
      .get() as { config_identity: string; epoch: number } | undefined
    const persisted = row?.config_identity ?? 'off'
    if (identity === null) return persisted === 'off'
    return persisted === identity && row?.epoch === epoch
  } catch {
    return false
  }
}

const ACTIVATION_DDL = `CREATE TABLE IF NOT EXISTS slayzone_idp_activation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  config_identity TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  activated_at INTEGER NOT NULL
)`

/** Human accounts: every user row but the computer service user and break-glass. */
const HUMANS = `SELECT id, role FROM "user" WHERE email <> ? AND email NOT LIKE 'break-glass%@hub.slayzone.local'`

export interface IdpActivation {
  epoch: number
  /** Unix ms the epoch began. */
  activatedAt: number
}

/** Run `fn` in one IMMEDIATE transaction (node:sqlite is synchronous: nothing interleaves). */
function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/**
 * The config identity an epoch is for: everything that decides who holds which role and
 * for how long — the issuer, provider and client, the claim, the mapping and the recheck
 * interval. Any change is a new activation.
 */
export function idpConfigIdentity(provider: SsoProvider, config: RoleConfig): string {
  const mapping = Object.keys(config.mapping)
    .sort()
    .map((k) => [k, [...(config.mapping[k] ?? [])].sort()])
  return createHash('sha256')
    .update(
      JSON.stringify({
        issuer: provider.issuer,
        providerId: provider.providerId,
        clientId: provider.clientId,
        claim: config.claim,
        mapping,
        intervalSec: config.intervalSec
      })
    )
    .digest('hex')
}

export function readIdpActivation(db: DatabaseSync): IdpActivation | null {
  db.exec(ACTIVATION_DDL)
  const row = db
    .prepare(
      'SELECT config_identity, epoch, activated_at FROM slayzone_idp_activation WHERE id = 1'
    )
    .get() as { config_identity: string; epoch: number; activated_at: number } | undefined
  if (!row || row.config_identity === 'off') return null
  return { epoch: row.epoch, activatedAt: row.activated_at }
}

/**
 * Persist the mode's state for this boot (see the module note). `identity` is
 * {@link idpConfigIdentity}, or null when the mode is off. Returns the human ids whose
 * access was invalidated (empty unless a new epoch began), for the hub to revoke what it
 * holds outside this database.
 */
export function recordIdpActivation(
  db: DatabaseSync,
  identity: string | null,
  nowMs: number = Date.now()
): { activated: boolean; epoch: number | null; invalidated: { id: string; role: HubRole }[] } {
  db.exec(ACTIVATION_DDL)
  return inTransaction(db, () => {
    const row = db
      .prepare('SELECT config_identity, epoch FROM slayzone_idp_activation WHERE id = 1')
      .get() as { config_identity: string; epoch: number } | undefined
    if (identity === null) {
      if (row && row.config_identity !== 'off') {
        db.prepare(`UPDATE slayzone_idp_activation SET config_identity = 'off' WHERE id = 1`).run()
      }
      return { activated: false, epoch: null, invalidated: [] }
    }
    if (row?.config_identity === identity) {
      return { activated: false, epoch: row.epoch, invalidated: [] }
    }
    const epoch = (row?.epoch ?? 0) + 1
    db.prepare(
      `INSERT INTO slayzone_idp_activation (id, config_identity, epoch, activated_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET config_identity = excluded.config_identity,
         epoch = excluded.epoch, activated_at = excluded.activated_at`
    ).run(identity, epoch, nowMs)
    const humans = (
      db.prepare(HUMANS).all(COMPUTER_SERVICE_USER_EMAIL) as { id: string; role: unknown }[]
    ).map((r) => ({ id: r.id, role: readRole(r.role) }))
    const clear = db.prepare(
      `UPDATE "user" SET role = 'user', idpVerifiedAt = NULL, idpGrantedAt = NULL,
         idpRevision = COALESCE(idpRevision, 0) + 1 WHERE id = ?`
    )
    const sessions = db.prepare('DELETE FROM session WHERE userId = ?')
    const apiKeys = db.prepare('DELETE FROM apikey WHERE referenceId = ?')
    for (const { id } of humans) {
      clear.run(id)
      sessions.run(id)
      apiKeys.run(id)
    }
    // Flows still pending from before the epoch die too: OAuth sign-in state and device
    // codes (the evidence cutoff refuses them anyway; this removes them outright).
    for (const table of ['verification', 'deviceCode']) {
      const exists = db
        .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(table)
      if (exists) db.prepare(`DELETE FROM "${table}"`).run()
    }
    return { activated: true, epoch, invalidated: humans }
  })
}

/** Emit one contract audit event as a security-log line. */
export function auditIdp(event: AuditEvent, outcome: 'success' | 'denied' = 'success'): void {
  const built = buildAuditEvent(event)
  securityEvent({
    event: built.event,
    outcome,
    actor: null,
    targetKind: 'user',
    targetId: built.subject,
    detail: { ...built }
  })
}

/** What the hub hooks into the mode: revocation outside hub-auth, role-change reconnects. */
export interface IdpRolesHub {
  /** End the account's sessions outside hub-auth (web sessions, sockets, direct grants). */
  revokeExternal?: (userId: string) => Promise<unknown>
  /** The account's role changed: close what captured the old one. */
  onRoleChange?: (userId: string, role: HubRole) => unknown
  /** True when the account holds a live session outside hub-auth (web sessions). */
  hasExternalSession?: (userId: string) => Promise<boolean>
  log?: (message: string) => void
}

export type IdpAuthorization =
  | { ok: true; role: HubRole }
  | { ok: false; reason: 'epoch' | 'no_evidence' | RevalidationReason | 'superseded' | 'error' }

export interface IdpRoles {
  readonly config: RoleConfig
  readonly activation: IdpActivation
  /**
   * The gate. `session`: when it was created (Unix ms) and, for a better-auth session,
   * the epoch it was created in (a web session has none: its creation time is compared
   * with the epoch's start). Never throws: any failure is a refusal.
   */
  authorize(
    userId: string,
    session: { createdAtMs: number; epoch?: number | null }
  ): Promise<IdpAuthorization>
  /**
   * The gate for a HUMAN acted for without a session of theirs — the task CLI relay,
   * where a computer's (automation) credential acts as its owner: the persisted mode,
   * a current grant and fresh evidence (revalidated inline when due).
   */
  authorizeAccount(userId: string): Promise<IdpAuthorization>
  /** Unix ms when the account's evidence expires, or null when it has none. */
  deadlineMs(userId: string): number | null
  /** Refresh every signed-in account within the margin of its deadline. Never rejects. */
  sweep(): Promise<void>
  /** A sign-in passed the checks: persist its evidence (session.create.before). */
  applySignIn(
    session: { userId?: unknown; createdAt?: unknown },
    ctx: Parameters<typeof signedInAccount>[1]
  ): Promise<void>
  /**
   * A session that is not an SSO sign-in is about to be created for `userId`
   * (session.create.before). Throws unless it is bound ({@link withIssuanceBinding}, or
   * `binding` given) to an authentication at or after the account's current grant, in
   * this runtime's epoch. Exempt accounts (break-glass, service) pass.
   */
  authorizeIssuance(userId: string, binding?: { authAtMs: number } | null): void
  /**
   * A verified sign-in mapped to no role (its signed evidence: `denial`): clear and
   * revoke the account — ordered like a grant, under the same lock. A denial signed in
   * or before the second of the current activation or the account's last revocation,
   * or before the stored verified evidence, decides nothing (the sign-in itself is
   * still refused): a delayed older denial never revokes a newer sign-in. Same-second
   * as the stored evidence: revoked (fail closed).
   */
  denyNoMappedRole(userId: string, denial: { subject: string; verifiedAt: number }): Promise<void>
  /**
   * Wire the hub's half (late: the hub builds it after hub-auth). Revokes, outside
   * hub-auth, the access of every human this boot's activation invalidated.
   */
  attachHub(hub: IdpRolesHub): Promise<void>
}

interface UserState {
  id: string
  email: string
  role: HubRole
  subject: string | null
  verifiedAt: number | null
  revision: number
  /** Unix ms; null = the account holds no access until a verified sign-in. */
  grantedAt: number | null
  /** Unix ms of the last revocation (0 = never): the evidence cutoff with the epoch. */
  revokedAt: number
}

interface AccountState {
  accountId: string
  refreshTokenCipher: string | null
}

const nowSec = (): number => Math.floor(Date.now() / 1000)

/**
 * Build the mode's runtime for an auth instance (auth.ts, when the provider's role mode
 * is `idp`). `getContext` resolves the instance's context (late: after betterAuth()).
 */
export function createIdpRoles(opts: {
  db: DatabaseSync
  cfg: SsoConfig
  getContext: () => Promise<AuthContext>
  activation: IdpActivation
  /** Humans this boot's activation invalidated (revoked outside hub-auth at attach). */
  invalidated?: readonly string[]
  fetch?: EntraFetch
}): IdpRoles {
  const provider = ssoProvider(opts.cfg)
  const config = provider.idpRoles
  if (!config) throw new Error('[hub-auth] IdP-role runtime without an enabled config')
  const { db, activation } = opts
  const keys = entraKeySet(opts.cfg, opts.fetch)
  let hub: IdpRolesHub = {}
  const log = (m: string) => (hub.log ?? ((x: string) => console.log(x)))(m)
  const locks = new Map<string, Promise<unknown>>()

  /** Serialize everything that reads-and-writes one identity's evidence. */
  function withLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(userId) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.catch(() => undefined)
    locks.set(userId, tail)
    void tail.then(() => {
      if (locks.get(userId) === tail) locks.delete(userId)
    })
    return run
  }

  const readUser = (userId: string): UserState | null => {
    const row = db
      .prepare(
        'SELECT id, email, role, idpSubject, idpVerifiedAt, idpRevision, idpGrantedAt, idpRevokedAt FROM "user" WHERE id = ?'
      )
      .get(userId) as
      | {
          id: string
          email: string
          role: unknown
          idpSubject: string | null
          idpVerifiedAt: number | null
          idpRevision: number | null
          idpGrantedAt: number | null
          idpRevokedAt: number | null
        }
      | undefined
    if (!row) return null
    return {
      id: row.id,
      email: row.email,
      role: readRole(row.role),
      subject: row.idpSubject,
      verifiedAt: typeof row.idpVerifiedAt === 'number' ? row.idpVerifiedAt : null,
      revision: row.idpRevision ?? 0,
      grantedAt: typeof row.idpGrantedAt === 'number' ? row.idpGrantedAt : null,
      revokedAt: typeof row.idpRevokedAt === 'number' ? row.idpRevokedAt : 0
    }
  }

  const readAccount = (userId: string): AccountState | null => {
    const row = db
      .prepare('SELECT accountId, refreshToken FROM account WHERE userId = ? AND providerId = ?')
      .get(userId, provider.providerId) as
      | { accountId: string; refreshToken: string | null }
      | undefined
    return row ? { accountId: row.accountId, refreshTokenCipher: row.refreshToken ?? null } : null
  }

  const identity = idpConfigIdentity(provider, config)
  /** This runtime still IS the persisted mode: same config identity and epoch. */
  const current = (): boolean => persistedMatches(db, identity, activation.epoch)

  /** The fence of every write: nothing this revalidation read has moved. */
  const assertUnchanged = (user: UserState, account: AccountState | null): void => {
    const now = readUser(user.id)
    const acc = readAccount(user.id)
    if (
      !now ||
      now.revision !== user.revision ||
      (acc?.refreshTokenCipher ?? null) !== (account?.refreshTokenCipher ?? null) ||
      !current()
    ) {
      throw new SupersededError()
    }
  }

  /**
   * Not gated: the computer service user and the break-glass account — server
   * administration's recovery path (./break-glass.ts), which opens only over the hub's
   * local admin socket. By address AND by having no SSO identity: an SSO sign-in can
   * never carry these reserved addresses (entra.ts refuses them), and an account that
   * somehow has an SSO row is gated like any person.
   */
  const isExempt = (user: UserState): boolean => {
    const reserved =
      user.email === COMPUTER_SERVICE_USER_EMAIL ||
      user.email === BREAK_GLASS_EMAIL ||
      isBreakGlassEmail(user.email)
    if (!reserved) return false
    const sso = db
      .prepare(`SELECT 1 FROM account WHERE userId = ? AND providerId IN ('microsoft', 'oidc')`)
      .get(user.id)
    return sso === undefined
  }

  /** Clear the account's managed authorization and revoke its human access (fenced). */
  async function revokeFenced(
    user: UserState,
    account: AccountState | null,
    reason: string
  ): Promise<void> {
    inTransaction(db, () => {
      assertUnchanged(user, account)
      // Managed authorization cleared to the lowest role and the access withdrawn; the
      // evidence time is left as it was (never advanced). Only a new verified sign-in —
      // signed later than it — grants access again, and only to sessions created from
      // then on.
      db.prepare(
        `UPDATE "user" SET role = 'user', idpRevision = ?, idpGrantedAt = NULL,
           idpRevokedAt = ? WHERE id = ?`
      ).run(user.revision + 1, Date.now(), user.id)
      db.prepare('DELETE FROM session WHERE userId = ?').run(user.id)
      db.prepare('DELETE FROM apikey WHERE referenceId = ?').run(user.id)
    })
    try {
      await hub.revokeExternal?.(user.id)
    } catch (err) {
      // The rows outside hub-auth are dead anyway: the gate refuses an account with no
      // evidence. Logged, never swallowed into access.
      log(
        `[idp-roles] revoking sessions outside hub-auth failed: ${err instanceof Error ? err.name : 'error'}`
      )
    }
    auditIdp(
      {
        event: 'idp_roles.denied',
        service: IDP_AUDIT_SERVICE,
        actor: IDP_ACTOR,
        subject: user.id,
        source: 'oidc',
        previousGrants: [user.role],
        newGrants: [],
        reason
      },
      'denied'
    )
  }

  async function revalidate(userId: string, force: boolean): Promise<IdpAuthorization> {
    return withLock(userId, async () => {
      // A runtime whose epoch is no longer the persisted one (another boot activated a
      // different config) decides nothing: fail closed.
      if (!current()) return { ok: false, reason: 'epoch' } as const
      const user = readUser(userId)
      if (!user) return { ok: false, reason: 'error' } as const
      if (!user.subject || user.verifiedAt === null)
        return { ok: false, reason: 'no_evidence' } as const
      // Cheap path: fresh evidence needs neither the account row nor the issuer.
      if (!force && freshness(nowSec(), user.verifiedAt, config!.intervalSec) === 'ok') {
        return { ok: true, role: user.role } as const
      }
      const account = readAccount(userId)
      const ctx = await opts.getContext()
      let refreshToken: string | null = null
      if (account?.refreshTokenCipher) {
        try {
          refreshToken = await decryptOAuthToken(account.refreshTokenCipher, ctx)
        } catch {
          refreshToken = null // → refresh_unavailable: sign in again
        }
      }
      let superseded = false
      let roleChanged: HubRole | null = null
      try {
        const result = await revalidateOidc({
          config: config!,
          now: nowSec(),
          verifiedAt: user.verifiedAt,
          subject: user.subject,
          currentGrants: [user.role],
          refreshToken,
          force,
          hooks: {
            getNow: nowSec,
            refresh: async (rt) => {
              const tokens = await refreshEntraTokens(opts.cfg, rt, {
                ...(opts.fetch ? { fetch: opts.fetch } : {}),
                signal: AbortSignal.timeout(IDP_REFRESH_TIMEOUT_MS)
              })
              // Omitted replacement = keep the stored one (contract: undefined, not null).
              return {
                idToken: tokens.idToken ?? null,
                ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {})
              }
            },
            verifyIdToken: async (idToken) => {
              const claims = await verifyIdTokenClaims(provider, idToken, keys)
              // Bound to this very account (Entra: oid + tid; generic: issuer + sub).
              if (!account || provider.accountIdOf(claims) !== account.accountId) {
                throw new Error('[hub-auth] refreshed ID token names another account')
              }
              return claims as Record<string, unknown>
            },
            resolveTargets: highestHubRole,
            persistVerified: async (state) => {
              const role = readRole(state.grants[0])
              let cipher: string | null | undefined
              if (state.refreshToken !== undefined) {
                cipher =
                  state.refreshToken === null ? null : await setTokenUtil(state.refreshToken, ctx)
              }
              inTransaction(db, () => {
                assertUnchanged(user, account)
                db.prepare(
                  `UPDATE "user" SET role = ?, idpVerifiedAt = ?,
                     idpRevision = ? WHERE id = ?`
                ).run(role, state.verifiedAt, user.revision + 1, user.id)
                if (cipher !== undefined) {
                  db.prepare(
                    'UPDATE account SET refreshToken = ? WHERE userId = ? AND providerId = ?'
                  ).run(cipher, user.id, provider.providerId)
                }
              })
              if (role !== user.role) roleChanged = role
            },
            requireSso: async ({ reason }) => {
              try {
                await revokeFenced(user, account, reason)
              } catch (err) {
                if (err instanceof SupersededError) superseded = true
                throw err
              }
            }
          }
        })
        if (result.status !== 'ok') return { ok: false, reason: result.reason } as const
        const role = readRole(result.grants[0])
        if (result.reason === 'verified') {
          auditIdp({
            event: 'idp_roles.revalidated',
            service: IDP_AUDIT_SERVICE,
            actor: IDP_ACTOR,
            subject: user.id,
            source: 'oidc',
            previousGrants: [user.role],
            newGrants: [role],
            reason: roleChanged ? 'role_changed' : 'verified'
          })
        }
        if (roleChanged) {
          securityEvent({
            event: 'user.role_change',
            outcome: 'success',
            actor: null,
            targetKind: 'user',
            targetId: user.id,
            detail: { reason: 'sso_recheck', role: roleChanged }
          })
          try {
            await hub.onRoleChange?.(user.id, roleChanged)
          } catch {
            // The role is written; sockets also close at the next deadline.
          }
        }
        return { ok: true, role } as const
      } catch {
        // The contract throws when its requireSso callback failed: deny this request.
        return { ok: false, reason: superseded ? 'superseded' : 'error' } as const
      }
    })
  }

  return {
    config,
    activation,
    async authorize(userId, session) {
      try {
        // First of all: this runtime's epoch must still be the persisted one.
        if (!current()) return { ok: false, reason: 'epoch' }
        const user = readUser(userId)
        if (!user) return { ok: false, reason: 'error' }
        if (isExempt(user)) return { ok: true, role: user.role }
        // The account holds access, and this session was created under it.
        if (user.grantedAt === null || session.createdAtMs < user.grantedAt) {
          return { ok: false, reason: 'no_evidence' }
        }
        // Sessions from before this epoch are dead even if a row survived.
        const inEpoch =
          session.epoch !== undefined
            ? session.epoch === activation.epoch
            : session.createdAtMs >= activation.activatedAt
        if (!inEpoch) return { ok: false, reason: 'epoch' }
        return await revalidate(userId, false)
      } catch {
        return { ok: false, reason: 'error' }
      }
    },
    async authorizeAccount(userId) {
      try {
        if (!current()) return { ok: false, reason: 'epoch' }
        const user = readUser(userId)
        if (!user) return { ok: false, reason: 'error' }
        if (isExempt(user)) return { ok: true, role: user.role }
        if (user.grantedAt === null) return { ok: false, reason: 'no_evidence' }
        return await revalidate(userId, false)
      } catch {
        return { ok: false, reason: 'error' }
      }
    },
    deadlineMs(userId) {
      const user = readUser(userId)
      if (!user || isExempt(user)) return null
      return user.verifiedAt === null ? 0 : (user.verifiedAt + config.intervalSec) * 1000
    },
    async sweep() {
      try {
        const margin = Math.min(IDP_SWEEP_MARGIN_SEC, Math.floor(config.intervalSec / 4))
        const due = db
          .prepare(
            `SELECT id FROM "user" WHERE idpVerifiedAt IS NOT NULL AND idpVerifiedAt + ? <= ?`
          )
          .all(config.intervalSec - margin, nowSec()) as { id: string }[]
        for (const { id } of due) {
          const live =
            (db.prepare('SELECT 1 FROM session WHERE userId = ? LIMIT 1').get(id) as unknown) !==
              undefined || (await hub.hasExternalSession?.(id)) === true
          if (live) await revalidate(id, true)
        }
      } catch (err) {
        log(
          `[idp-roles] sweep failed, retried next tick: ${err instanceof Error ? err.name : 'error'}`
        )
      }
    },
    async applySignIn(session, ctx) {
      const signedIn = await signedInAccount(session, ctx)
      if (!signedIn?.verdict.evidence) return
      const { verdict, userId } = signedIn
      const evidence = verdict.evidence!
      await withLock(userId, async () => {
        const user = readUser(userId)
        if (!user) throw new Error('[hub-auth] IdP sign-in for a missing account')
        const role = readRole(evidence.grants[0])
        // Evidence only moves forward: a sign-in signed BEFORE the stored evidence (a
        // delayed callback, across a revocation too) is superseded — refused, never
        // allowed to put back an older role.
        // …and only from after the cutoff: signed in a later second than both this
        // epoch's activation and the account's last revocation.
        const cutoffSec = Math.floor(Math.max(activation.activatedAt, user.revokedAt) / 1000)
        const preCutoff = evidence.verifiedAt <= cutoffSec
        if (preCutoff || (user.verifiedAt !== null && evidence.verifiedAt < user.verifiedAt)) {
          auditIdp(
            {
              event: 'idp_roles.denied',
              service: IDP_AUDIT_SERVICE,
              actor: IDP_ACTOR,
              subject: userId,
              source: 'oidc',
              previousGrants: [user.role],
              newGrants: [],
              reason: preCutoff ? 'pre_cutoff_evidence' : 'superseded_evidence'
            },
            'denied'
          )
          throw new SupersededError()
        }
        // Access (re)granted from THIS sign-in's session on, when the account had none.
        const createdAtMs = new Date(
          (session.createdAt as string | Date | undefined) ?? Date.now()
        ).getTime()
        inTransaction(db, () => {
          if (!current()) throw new SupersededError()
          db.prepare(
            `UPDATE "user" SET role = ?, idpSubject = ?,
               idpVerifiedAt = MAX(COALESCE(idpVerifiedAt, 0), ?), idpRevision = ?,
               idpGrantedAt = COALESCE(idpGrantedAt, ?) WHERE id = ?`
          ).run(role, evidence.subject, evidence.verifiedAt, user.revision + 1, createdAtMs, userId)
        })
        auditIdp({
          event: 'idp_roles.granted',
          service: IDP_AUDIT_SERVICE,
          actor: IDP_ACTOR,
          subject: userId,
          source: 'oidc',
          previousGrants: user.verifiedAt === null ? [] : [user.role],
          newGrants: [role],
          reason: 'sign_in'
        })
        if (user.verifiedAt !== null && role !== user.role) {
          securityEvent({
            event: 'user.role_change',
            outcome: 'success',
            actor: null,
            targetKind: 'user',
            targetId: userId,
            detail: { reason: 'sso_claim', role }
          })
          try {
            await hub.onRoleChange?.(userId, role)
          } catch {
            // Sockets also close at the next deadline.
          }
        }
      })
    },
    authorizeIssuance(userId, binding) {
      const bound = binding ?? issuance.getStore() ?? null
      const user = readUser(userId)
      if (!user) throw new SupersededError()
      if (isExempt(user)) return
      if (
        !current() ||
        !bound ||
        !Number.isFinite(bound.authAtMs) ||
        user.grantedAt === null ||
        bound.authAtMs < user.grantedAt
      ) {
        auditIdp(
          {
            event: 'idp_roles.denied',
            service: IDP_AUDIT_SERVICE,
            actor: IDP_ACTOR,
            subject: userId,
            source: 'oidc',
            previousGrants: [user.role],
            newGrants: [],
            reason: bound ? 'stale_authorization' : 'unbound_issuance'
          },
          'denied'
        )
        throw new SupersededError()
      }
    },
    async denyNoMappedRole(userId, denial) {
      await withLock(userId, async () => {
        if (!current()) return // a stale runtime decides nothing
        const user = readUser(userId)
        if (!user || isExempt(user)) return
        const cutoffSec = Math.floor(Math.max(activation.activatedAt, user.revokedAt) / 1000)
        const superseded =
          denial.verifiedAt <= cutoffSec ||
          (user.verifiedAt !== null && denial.verifiedAt < user.verifiedAt) ||
          (user.subject !== null && user.subject !== denial.subject)
        if (superseded) {
          auditIdp(
            {
              event: 'idp_roles.denied',
              service: IDP_AUDIT_SERVICE,
              actor: IDP_ACTOR,
              subject: userId,
              source: 'oidc',
              previousGrants: [user.role],
              newGrants: [user.role],
              reason: 'superseded_denial'
            },
            'denied'
          )
          return
        }
        await revokeFenced(user, readAccount(userId), 'no_mapped_role')
      })
    },
    async attachHub(next) {
      hub = next
      for (const userId of opts.invalidated ?? []) {
        try {
          await hub.revokeExternal?.(userId)
        } catch {
          log('[idp-roles] activation: revoking sessions outside hub-auth failed for one account')
        }
      }
    }
  }
}

const runtimes = new WeakMap<object, IdpRoles>()

/** Register an instance's runtime (auth.ts). */
export function setIdpRoles(auth: object, runtime: IdpRoles): void {
  runtimes.set(auth, runtime)
}

/** The IdP-role runtime of an instance, or null with the mode off. */
export function idpRolesOf(auth: object): IdpRoles | null {
  return runtimes.get(auth) ?? null
}

/** True for an instance running the IdP-role mode. */
export function isIdpRolesAuth(auth: object): boolean {
  return runtimes.has(auth)
}
