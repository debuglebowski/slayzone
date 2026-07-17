/**
 * tRPC connection-context decisions for the hub's `/trpc` listener, factored out
 * of `startServer` so the two security-relevant choices are unit-testable
 * without the full boot (composeServer → better-auth migrations → listeners).
 * Mirrors the `runner-listener.ts` split: the bind/degradation decision lives in
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

/** The attributed principal for an authenticated `/trpc` connection. */
export interface ConnectionPrincipal {
  userId: string
  orgId?: string | null
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
  /** Whether THIS hub enforces auth (`SLAYZONE_HUB_AUTH_REQUIRED=1` + hubAuth present). */
  hubAuthRequired: boolean
  /** The hub's better-auth instance, or null when runner/auth mode is off. */
  hubAuth: HubAuth | null
  /** The bearer token from tRPC `connectionParams`, if the client sent one. */
  token: string | null | undefined
}

/**
 * Resolve the verified principal for a connecting client, or null.
 *
 * When the hub does NOT enforce auth (local loopback / non-authed remote — the
 * default), this is a straight null with no verify call → byte-identical to the
 * trusted-loopback path. When it DOES enforce auth, a present non-blank token is
 * verified via `verifySession`; anything else (absent/blank token, unverifiable
 * token, or a thrown error inside verify) resolves to null so the connection is
 * still ACCEPTED at the socket level (the client must reach the open
 * `hub.describe` to discover auth is required) but attributed as unauthenticated
 * — gated procedures then 401 via the auth gate.
 */
export async function resolveConnectionPrincipal(
  opts: ResolvePrincipalOptions
): Promise<ConnectionPrincipal | null> {
  if (!opts.hubAuthRequired || !opts.hubAuth) return null
  const token = opts.token
  if (typeof token !== 'string' || !token) return null
  try {
    const ctx = await verifySession(opts.hubAuth, new Headers({ authorization: `Bearer ${token}` }))
    return ctx ? { userId: ctx.userId, orgId: ctx.orgId } : null
  } catch {
    // Verification failure → unauthenticated (principal null), never throw.
    return null
  }
}
