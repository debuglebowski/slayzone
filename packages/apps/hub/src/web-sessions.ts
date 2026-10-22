/**
 * Scoped browser sessions — the credential a web login mints, distinct from a
 * full better-auth session.
 *
 * WHY THIS EXISTS: a browser reached over the internet must never hold `full`
 * access for even one request — see `resolveConnectionPrincipal`'s docstring
 * for the design this implements. Sign-in itself is scoped: `mintWebSession`
 * is called AFTER better-auth's own `signInEmail` has already succeeded and
 * been discarded (see the `/api/auth/web-login` route), so the full session
 * that authenticated the human never leaves this process.
 *
 * TOKEN FORMAT: `szw_<43 chars base64url>` (32 random bytes). The `szw_`
 * prefix is load-bearing at the resolver: `resolveConnectionPrincipal` and the
 * REST bearer resolver both branch on it BEFORE touching either credential
 * store, so a `szw_`-prefixed value is never even tried against
 * `verifySession`, and a real better-auth bearer never reaches this table's
 * lookup. Mirrors `join-tokens.ts`'s `szjt1.` convention: store only
 * `sha256(token)`, return the plaintext exactly once.
 *
 * @module hub/web-sessions
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { SlayzoneDb } from '@slayzone/platform'
import { CLIENT_ADDRESS_HEADER } from '@slayzone/platform/client-address'
import { currentSecurityContext, securityEvent } from '@slayzone/platform/security-log'
import { findHubAccount, type HubAuth, isEntraSsoAuth } from '@slayzone/hub-auth/server'
import type { HubRole } from '@slayzone/hub-auth'
import type { Scope } from '@slayzone/transport/server'

/**
 * The scope bundle a web login mints today. Phase 1 has no UI for choosing a
 * narrower set, so every scoped session gets the full product bundle this
 * plan's `scopes.ts` defines — `read` + `tasks` + `agent`, deliberately never
 * `full`. Revisit once there is a reason to mint anything narrower (e.g. a
 * read-only share link).
 */
export const DEFAULT_WEB_LOGIN_SCOPES: readonly Scope[] = ['read', 'tasks', 'agent']

export const WEB_SESSION_TOKEN_PREFIX = 'szw_'

/**
 * The cookie a browser session's token rides in. `HttpOnly; Secure;
 * SameSite=Lax; Path=/` — set by the login route, read by the REST bearer
 * resolver. `Lax` (not `Strict`) so a link from Slack/email lands signed in;
 * the CSRF control for state-changing requests is the WS/HTTP origin check
 * (`ws-origin.ts` and its future REST-side counterpart), not the cookie's
 * SameSite attribute alone.
 */
export const WEB_SESSION_COOKIE_NAME = 'slayzone_web_session'

/** Default lifetime for a freshly-minted web session (7 days), and the
 *  absolute ceiling `refreshWebSession` will never extend past (30 days from
 *  ORIGINAL creation, not from the most recent refresh — a stolen-but-still-
 *  used token must still die eventually). */
export const WEB_SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000
export const WEB_SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * How long a web session lives: `idleMs` after its last use, and never past
 * `absoluteMs` after it was minted.
 */
export interface WebSessionLifetime {
  idleMs: number
  absoluteMs: number
}

/** Every hub without Entra sign-in (the desktop app's included): unchanged, 7 days idle
 *  within 30 days. */
export const DEFAULT_WEB_SESSION_LIFETIME: WebSessionLifetime = {
  idleMs: WEB_SESSION_IDLE_MS,
  absoluteMs: WEB_SESSION_ABSOLUTE_MS
}

/**
 * A hub with Entra sign-in (O-8, T-12): 7 days ABSOLUTE — use does not extend it. No
 * shorter idle limit: a leaver is ended by disabling (which revokes) or by the hourly
 * Entra re-check, not by a browser going quiet, and a daily sign-in would only add
 * friction.
 */
export const SSO_WEB_SESSION_LIFETIME: WebSessionLifetime = {
  idleMs: 7 * 24 * 60 * 60 * 1000,
  absoluteMs: 7 * 24 * 60 * 60 * 1000
}

/** The lifetime web sessions get on the hub `auth` belongs to. */
export function webSessionLifetimeFor(auth: HubAuth | null): WebSessionLifetime {
  return auth && isEntraSsoAuth(auth) ? SSO_WEB_SESSION_LIFETIME : DEFAULT_WEB_SESSION_LIFETIME
}

export interface WebSessionRow {
  id: string
  user_id: string
  token_hash: string
  scopes_json: string
  label: string | null
  created_at: number
  expires_at: number
  revoked_at: number | null
}

export interface MintWebSessionInput {
  userId: string
  scopes: readonly Scope[]
  label?: string | null
  /** Default {@link DEFAULT_WEB_SESSION_LIFETIME}. */
  lifetime?: WebSessionLifetime
  /** Clock override for tests. */
  now?: number
}

export interface MintedWebSession {
  id: string
  /** Plaintext token — show/set-cookie once, never stored. */
  token: string
  expiresAt: number
}

/** `sha256(token)`, hex — the only form persisted. */
export function hashWebSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Cheap shape check so a caller can route without a DB round trip: is this
 *  even a plausible web-session token? Does NOT validate it exists or is live —
 *  only that it carries the prefix, so a normal better-auth bearer is never
 *  looked up against this table. */
export function isWebSessionToken(value: string): boolean {
  return (
    value.startsWith(WEB_SESSION_TOKEN_PREFIX) && value.length > WEB_SESSION_TOKEN_PREFIX.length
  )
}

export async function mintWebSession(
  db: SlayzoneDb,
  input: MintWebSessionInput
): Promise<MintedWebSession> {
  const now = input.now ?? Date.now()
  const token = `${WEB_SESSION_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
  const id = randomUUID()
  const lifetime = input.lifetime ?? DEFAULT_WEB_SESSION_LIFETIME
  const expiresAt = now + Math.min(lifetime.idleMs, lifetime.absoluteMs)
  await db.run(
    `INSERT INTO web_sessions
       (id, user_id, token_hash, scopes_json, label, created_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      id,
      input.userId,
      hashWebSessionToken(token),
      JSON.stringify(input.scopes),
      input.label ?? null,
      now,
      expiresAt
    ]
  )
  securityEvent({
    event: 'auth.web_session.create',
    outcome: 'success',
    actor: input.userId,
    targetKind: 'web_session',
    targetId: id,
    detail: { scopes: input.scopes }
  })
  return { id, token, expiresAt }
}

export type VerifyWebSessionResult =
  | { ok: true; userId: string; scopes: Scope[] }
  | { ok: false; reason: 'unknown' | 'revoked' | 'expired' }

/**
 * Verify a token and, on success, slide its idle expiry forward — capped at
 * `lifetime.absoluteMs` from ORIGINAL `created_at`, never from the refresh
 * itself, so a continuously-used stolen token still dies within 30 days (7 on a hub
 * with Entra sign-in, where idle = absolute and nothing slides).
 *
 * Fails CLOSED on anything but a clean hit: unknown hash, `revoked_at` set, past
 * `expires_at`, or older than the absolute limit (a row minted under a longer one, on
 * a hub that has since turned Entra sign-in on) are all `ok: false` — never throws,
 * matching the fail-quiet shape `verifySession`/`verifyRestBearer` already establish
 * for this codebase. This checks the ROW only; {@link resolveWebSession} also checks
 * the account behind it.
 */
export async function verifyWebSessionToken(
  db: SlayzoneDb,
  token: string,
  now = Date.now(),
  lifetime: WebSessionLifetime = DEFAULT_WEB_SESSION_LIFETIME
): Promise<VerifyWebSessionResult> {
  const row = await db.get<WebSessionRow>(`SELECT * FROM web_sessions WHERE token_hash = ?`, [
    hashWebSessionToken(token)
  ])
  if (!row) return { ok: false, reason: 'unknown' }
  if (row.revoked_at !== null) return { ok: false, reason: 'revoked' }
  const ceiling = row.created_at + lifetime.absoluteMs
  if (row.expires_at <= now || ceiling <= now) return { ok: false, reason: 'expired' }

  const slidExpiry = Math.min(now + lifetime.idleMs, ceiling)
  if (slidExpiry > row.expires_at) {
    // Best-effort refresh — a write failure here must not fail the request
    // that is already legitimately authenticated by the row just read.
    try {
      await db.run(`UPDATE web_sessions SET expires_at = ? WHERE id = ?`, [slidExpiry, row.id])
    } catch {
      /* the caller still authenticates on the pre-refresh row */
    }
  }

  let scopes: unknown
  try {
    scopes = JSON.parse(row.scopes_json)
  } catch {
    return { ok: false, reason: 'unknown' } // corrupt row — treat as no session
  }
  if (!Array.isArray(scopes)) return { ok: false, reason: 'unknown' }
  return { ok: true, userId: row.user_id, scopes: scopes as Scope[] }
}

/** The principal a live web session resolves to. */
export interface WebSessionPrincipal {
  userId: string
  role: HubRole
  scopes: Scope[]
}

/**
 * A `szw_` token → its principal, or null. The ONE web-session resolver both doors
 * use (`resolveConnectionPrincipal` for `/trpc`, `verifyRestBearer` for `/api/*`).
 *
 * {@link verifyWebSessionToken} checks the ROW (known, not revoked, not expired);
 * this also checks the ACCOUNT behind it in hub-auth: gone or disabled → null, else
 * its role. Disabling an account revokes its rows (`revokeAllWebSessions`); this is
 * the second line, for a row that exists anyway. No hub-auth instance → null: the
 * account cannot be checked, so the session is not honoured.
 */
export async function resolveWebSession(
  auth: HubAuth | null,
  db: SlayzoneDb,
  token: string
): Promise<WebSessionPrincipal | null> {
  const result = await verifyWebSessionToken(db, token, Date.now(), webSessionLifetimeFor(auth))
  if (!result.ok || !auth) return null
  const account = await findHubAccount(auth, result.userId)
  if (!account || account.disabled) return null
  return { userId: result.userId, role: account.role, scopes: result.scopes }
}

/**
 * True when the user holds a web session that would still verify (the Entra re-check
 * asks only about accounts somebody is signed in to).
 */
export async function hasLiveWebSession(
  db: SlayzoneDb,
  userId: string,
  lifetime: WebSessionLifetime = DEFAULT_WEB_SESSION_LIFETIME,
  now = Date.now()
): Promise<boolean> {
  const row = await db.get<{ id: string }>(
    `SELECT id FROM web_sessions
     WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? AND created_at > ?
     LIMIT 1`,
    [userId, now, now - lifetime.absoluteMs]
  )
  return row !== undefined
}

export async function listWebSessions(db: SlayzoneDb, userId: string): Promise<WebSessionRow[]> {
  return db.all<WebSessionRow>(
    `SELECT * FROM web_sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
    [userId]
  )
}

/** Revoke one session by id. Returns false when no such (unrevoked) row exists. */
export async function revokeWebSession(
  db: SlayzoneDb,
  id: string,
  now = Date.now()
): Promise<boolean> {
  const result = await db.run(
    `UPDATE web_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
    [now, id]
  )
  // Who revoked it comes from the request context.
  securityEvent({
    event: 'auth.web_session.revoke',
    outcome: result.changes > 0 ? 'success' : 'failure',
    targetKind: 'web_session',
    targetId: id,
    detail: result.changes > 0 ? undefined : { reason: 'not_found' }
  })
  return result.changes > 0
}

/** Revoke every live session for a user — "log out everywhere". */
export async function revokeAllWebSessions(
  db: SlayzoneDb,
  userId: string,
  now = Date.now()
): Promise<number> {
  const result = await db.run(
    `UPDATE web_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`,
    [now, userId]
  )
  securityEvent({
    event: 'auth.web_session.revoke',
    outcome: 'success',
    targetKind: 'user',
    targetId: userId,
    detail: { count: result.changes }
  })
  return result.changes
}

export type WebLoginResult =
  | { ok: true; token: string; cookieName: string; maxAgeSec: number }
  | { ok: false; error: string }

/**
 * Scoped sign-in: the ONLY entry point that turns an email+password into a web
 * session, and the reason a browser never holds `full` for even one request.
 *
 * Calls better-auth's OWN `signInEmail` — the exact check `slay hub login`
 * uses — then DISCARDS its result entirely (the full session it creates is
 * never read past this function, never logged, never returned to the caller)
 * and mints a scoped `web_sessions` row instead. An exchange-a-full-token
 * design cannot promise that: for at least one request, the browser would hold
 * `full`, and an XSS at that instant steals it. This design never lets that
 * moment exist.
 *
 * Fails closed and UNIFORMLY on both "no such account" and "wrong password" —
 * better-auth itself already declines to distinguish these (the same
 * `UNAUTHORIZED` either way), which is the correct behavior for a login
 * endpoint; this just doesn't unwrap a different one.
 */
export async function webLogin(
  auth: HubAuth | null,
  db: SlayzoneDb,
  email: string,
  password: string
): Promise<WebLoginResult> {
  if (!auth) return { ok: false, error: 'hub-auth unavailable' }
  let userId: string
  try {
    // The caller's client address (T-22) — this runs inside the request's audit
    // context — so the session row better-auth writes carries it, like an HTTP sign-in.
    const ip = currentSecurityContext()?.ip
    const signedIn = await auth.api.signInEmail({
      body: { email, password },
      ...(ip ? { headers: new Headers({ [CLIENT_ADDRESS_HEADER]: ip }) } : {})
    })
    userId = signedIn.user.id
  } catch {
    return { ok: false, error: 'invalid email or password' }
  }
  const lifetime = webSessionLifetimeFor(auth)
  const minted = await mintWebSession(db, { userId, scopes: DEFAULT_WEB_LOGIN_SCOPES, lifetime })
  return {
    ok: true,
    token: minted.token,
    cookieName: WEB_SESSION_COOKIE_NAME,
    maxAgeSec: Math.floor(Math.min(lifetime.idleMs, lifetime.absoluteMs) / 1000)
  }
}
