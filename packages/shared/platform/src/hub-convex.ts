/**
 * The Convex deployment a hub starts GitHub sign-in against (T-99).
 *
 * THE HOLE. `app.auth.githubSystemSignIn` took `convexUrl` from the CLIENT and the hub
 * POSTed `auth:signIn` to `<that origin>/api/action`. On a shared hub that is a
 * server-side request to any host a signed-in user names, internal addresses included.
 * Now the hub only ever POSTs to its OWN deployment, {@link HUB_CONVEX_ADDRESS_ENV}, and
 * refuses a client value that names another (`assertHubConvexSignInUrl` in
 * `hub-switch-refusal.ts`). Unset = no Convex sign-in on this hub at all.
 *
 * WHY THE CLIENT STILL SENDS ONE. The client's Convex session (PKCE verifier, token
 * storage) is keyed by the URL it was built with, so a hub that silently swapped in its
 * own deployment would start a flow the client can never finish. Comparing turns "this
 * client was built for another Convex" into a clear refusal.
 *
 * THE DESKTOP APP'S HUB. Its main process is built from the same env as its renderer
 * (`electron.vite.config.ts` → `__SLAYZONE_CONVEX_URL__` ← `VITE_CONVEX_URL`) and hands
 * that deployment to its hub through the sidecar supervisor ({@link convexAddressFromUrl}),
 * so the renderer and the hub always name the same one.
 *
 * Address, not URL (CLAUDE.md env rule 5): `host[:port]`, the scheme derives from the
 * host — loopback → http (a local `npx convex dev` backend), anything else → https.
 *
 * Lean leaf (hub-addr + hub-switches only), also the `@slayzone/platform/hub-convex`
 * subpath.
 *
 * @module platform/hub-convex
 */
import { isBareAuthority, isLoopbackAuthority } from './hub-addr'
import { HUB_CONVEX_ADDRESS_ENV } from './hub-switches'

/** Origin of an `http(s)://…` URL; null when it is not a string, unparseable, or another scheme. */
export function convexOriginOf(url: unknown): string | null {
  if (typeof url !== 'string') return null
  try {
    const u = new URL(url.trim())
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null
  } catch {
    return null
  }
}

/**
 * Origin of a bare `host[:port]` under the scheme rule (loopback → http, else https);
 * null when it is not a bare authority (a full URL is refused, not guessed at).
 */
export function convexOriginFromAddress(addr: string): string | null {
  if (!isBareAuthority(addr)) return null
  return convexOriginOf(`${isLoopbackAuthority(addr) ? 'http' : 'https'}://${addr}`)
}

/**
 * This hub's Convex origin, from {@link HUB_CONVEX_ADDRESS_ENV}. Null when unset, blank,
 * or not a bare `host[:port]` (a full URL is refused, not guessed at) — callers treat
 * null as "no Convex sign-in here" and refuse.
 */
export function hubConvexOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const addr = env[HUB_CONVEX_ADDRESS_ENV]?.trim()
  return addr ? convexOriginFromAddress(addr) : null
}

/**
 * The {@link HUB_CONVEX_ADDRESS_ENV} value for a Convex URL (the build's
 * `VITE_CONVEX_URL`), for a parent that spawns a hub: its `host[:port]`.
 *
 * Undefined when the URL is blank, unparseable, not http(s), or would not round-trip
 * through the scheme rule (plain http to a non-loopback host): such a hub is then
 * "not configured" and says so, rather than silently signing in against a different
 * scheme than the client was built for.
 */
export function convexAddressFromUrl(url: string | undefined): string | undefined {
  const origin = convexOriginOf(url)
  if (origin === null) return undefined
  const addr = new URL(origin).host
  return convexOriginFromAddress(addr) === origin ? addr : undefined
}
