/**
 * tRPC connection-context decisions for the hub's `/trpc` listener, factored out
 * of `startServer` so the two security-relevant choices are unit-testable
 * without the full boot (composeServer → better-auth migrations → listeners).
 * Mirrors the `computer-listener.ts` split: the bind/degradation decision lives in
 * its own module for the same reason.
 *
 * Two decisions live here:
 *   - `parseWindowIdFromUrl` — the `?windowId=N` query param → `ctx.windowId`
 *     (required by claimSession + panel-ownership + warm-pool procs; a missing
 *     one throws "windowId required" downstream).
 *   - `resolveConnectionPrincipal` — verify the bearer token from tRPC
 *     `connectionParams` into a principal, but ONLY when this hub enforces auth.
 *     Fail-closed + fail-quiet: any absent/blank/invalid token, or a verify
 *     throw, yields a null principal (unauthenticated) rather than bubbling.
 *
 * @module server/hub-trpc-context
 */
import type { HubAuth } from '@slayzone/hub-auth/server'
import { verifySession } from '@slayzone/hub-auth/server'
import type { SlayzoneDb } from '@slayzone/platform'
import type { Scope } from '@slayzone/transport/server'
import { isWebSessionToken, verifyWebSessionToken } from './web-sessions.js'

/**
 * The attributed principal for an authenticated `/trpc` connection.
 *
 * TWO CREDENTIAL CLASSES resolve here, mirroring `verifyRestBearer`'s twin
 * decision for `/api/*` (`rest-auth.ts`):
 *   - `verifySession` (desktop, CLI, a co-located `slay` via the
 *     bootstrap-owner token) → always `['full']`.
 *   - a `szw_`-prefixed token → the `web_sessions` row's OWN `scopes`, never
 *     `full`. Unlike the REST side, tRPC is where a scoped web session
 *     actually DOES its work — `/api/*` refuses it outright (see
 *     `withRestAuth`), so `SCOPE_POLICY`'s per-procedure granularity is the
 *     only place a browser's narrower access is enforced at all.
 */
export interface ConnectionPrincipal {
  userId: string
  orgId?: string | null
  scopes: readonly Scope[]
}

/**
 * Parse `?windowId=N` from a WS upgrade request url. Returns the integer when
 * present and finite, else null (malformed url / absent / non-numeric).
 */
export function parseWindowIdFromUrl(rawUrl: string | undefined): number | null {
  try {
    const u = new URL(rawUrl ?? '/', 'http://localhost')
    const wid = u.searchParams.get('windowId')
    if (wid == null) return null
    const n = Number(wid)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

export interface ResolvePrincipalOptions {
  /** Whether THIS hub enforces auth (derived: `!supervised`, see `server.ts`). */
  hubAuthRequired: boolean
  /** The hub's better-auth instance, or null when computer/auth mode is off. */
  hubAuth: HubAuth | null
  /** The app db — needed to resolve a `szw_` web-session token. Null on a host
   *  with no such table (there is none today; kept optional for symmetry with
   *  `verifyRestBearer`'s signature and any future capability-only caller). */
  db: SlayzoneDb | null
  /** The bearer token from tRPC `connectionParams`, if the client sent one. */
  token: string | null | undefined
}

/**
 * Resolve the verified principal for a connecting client, or null.
 *
 * When the hub does NOT enforce auth (local loopback / non-authed remote — the
 * default), this is a straight null with no verify call → byte-identical to the
 * trusted-loopback path. When it DOES enforce auth, a present non-blank token is
 * checked by PREFIX first — `szw_` resolves against `web_sessions` (→ its own
 * scopes), anything else against `verifySession` (→ `['full']`). Either branch:
 * anything but a clean hit (absent/blank token, unverifiable/expired/revoked
 * token, or a thrown error) resolves to null so the connection is still
 * ACCEPTED at the socket level (the client must reach the open `hub.describe`
 * to discover auth is required) but attributed as unauthenticated — gated
 * procedures then 401/403 via the auth + scope gates.
 */
export async function resolveConnectionPrincipal(
  opts: ResolvePrincipalOptions
): Promise<ConnectionPrincipal | null> {
  if (!opts.hubAuthRequired) return null
  const token = opts.token
  if (typeof token !== 'string' || !token) return null

  if (isWebSessionToken(token)) {
    if (!opts.db) return null
    try {
      const result = await verifyWebSessionToken(opts.db, token)
      return result.ok ? { userId: result.userId, scopes: result.scopes } : null
    } catch {
      return null
    }
  }

  if (!opts.hubAuth) return null
  try {
    const ctx = await verifySession(opts.hubAuth, new Headers({ authorization: `Bearer ${token}` }))
    return ctx ? { userId: ctx.userId, orgId: ctx.orgId, scopes: ['full'] } : null
  } catch {
    // Verification failure → unauthenticated (principal null), never throw.
    return null
  }
}
