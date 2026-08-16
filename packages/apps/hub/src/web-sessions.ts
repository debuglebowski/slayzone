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
import type { HubAuth } from '@slayzone/hub-auth/server'
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
  const expiresAt = now + WEB_SESSION_IDLE_MS
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
  return { id, token, expiresAt }
}

export type VerifyWebSessionResult =
  | { ok: true; userId: string; scopes: Scope[] }
  | { ok: false; reason: 'unknown' | 'revoked' | 'expired' }

/**
 * Verify a token and, on success, slide its idle expiry forward — capped at
 * `WEB_SESSION_ABSOLUTE_MS` from ORIGINAL `created_at`, never from the refresh
 * itself, so a continuously-used stolen token still dies within 30 days.
 *
 * Fails CLOSED on anything but a clean hit: unknown hash, `revoked_at` set, or
 * past `expires_at` are all `ok: false` — never throws, matching the fail-quiet
 * shape `verifySession`/`verifyRestBearer` already establish for this codebase.
 */
export async function verifyWebSessionToken(
  db: SlayzoneDb,
  token: string,
  now = Date.now()
): Promise<VerifyWebSessionResult> {
  const row = await db.get<WebSessionRow>(`SELECT * FROM web_sessions WHERE token_hash = ?`, [
    hashWebSessionToken(token)
  ])
  if (!row) return { ok: false, reason: 'unknown' }
  if (row.revoked_at !== null) return { ok: false, reason: 'revoked' }
  if (row.expires_at <= now) return { ok: false, reason: 'expired' }

  const slidExpiry = Math.min(now + WEB_SESSION_IDLE_MS, row.created_at + WEB_SESSION_ABSOLUTE_MS)
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
    const signedIn = await auth.api.signInEmail({ body: { email, password } })
    userId = signedIn.user.id
  } catch {
    return { ok: false, error: 'invalid email or password' }
  }
  const minted = await mintWebSession(db, { userId, scopes: DEFAULT_WEB_LOGIN_SCOPES })
  return {
    ok: true,
    token: minted.token,
    cookieName: WEB_SESSION_COOKIE_NAME,
    maxAgeSec: Math.floor(WEB_SESSION_IDLE_MS / 1000)
  }
}
