/**
 * Origin guard for the `/trpc` WebSocket upgrade.
 *
 * WHY THIS EXISTS: `/trpc` exposes the ENTIRE app router — pty spawn, browser
 * eval, `shell.openExternal`, file ops, the auth-callback relay. A drive-by web
 * page, or a DNS rebind that resolves an attacker hostname to 127.0.0.1, must not
 * be able to open that socket from a victim's browser.
 *
 * WHY IT IS ITS OWN MODULE: this used to be a closure inside `startServer`, which
 * made it the one security decision in the hub with NO unit test — you cannot
 * reach it without booting two listeners. `rest-auth.ts` and `hub-trpc-context.ts`
 * both call out in their docstrings that they were extracted as pure functions
 * precisely so the decision is testable. This is the third.
 *
 * WHAT IT IS NOT: this is defense in depth, not the auth boundary. A non-browser
 * client sends no `Origin` at all and is admitted here, then gated by
 * `restAuthAction` / the tRPC auth gate like everything else. The guard's job is
 * to stop a BROWSER being turned into a confused deputy, which is a threat only
 * browsers can pose because only browsers attach ambient credentials.
 *
 * @module hub/ws-origin
 */

import { hubUrlFromAddr } from '@slayzone/platform/hub-addr'
import { HUB_ALLOWED_WEB_ORIGINS_ENV } from '@slayzone/platform/hub-switches'

/** Origins that only ever belong to a local, first-party client. */
const LOCAL_CLIENT_PROTOCOLS = new Set(['chrome:', 'chrome-extension:', 'devtools:', 'file:'])

/**
 * Hostnames that name this machine, as `URL.hostname` reports them.
 *
 * The IPv6 literal is BRACKETED here — WHATWG `URL` keeps the brackets
 * (`new URL('http://[::1]:8765').hostname === '[::1]'`). The pre-extraction
 * implementation compared against a bare `'::1'`, which therefore never matched
 * any real origin; the bare form is kept alongside so neither spelling depends on
 * that detail being remembered.
 */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export type WsOriginDecision = 'accept' | 'reject'

export interface WsOriginOptions {
  /** The `Origin` header, if the client sent one. */
  origin: string | undefined
  /**
   * Whether this hub requires login (`SLAYZONE_HUB_REQUIRE_LOGIN`). A hub that does
   * NOT is, by boot rule B1, reachable only from this machine — the desktop app's
   * hub is the case — so its clients are first-party and serve renderers at
   * `file://` / `chrome://` / `null`.
   */
  requireLogin: boolean
  /**
   * Whether this hub is reachable ONLY from this machine: it binds a loopback
   * address AND publishes no public address. A loopback hub is the normal dev
   * shape (the Chromium fork's backend, `pnpm dev`, the web dev server) and its
   * clients legitimately live at `http://localhost:<port>`. A loopback hub behind a
   * same-box reverse proxy (a public address is set) is NOT local: the proxy makes
   * the internet its browser.
   */
  loopbackBind: boolean
  /**
   * Exact origins this hub additionally accepts, e.g. the public origin a
   * browser-served web UI runs at. Compared as full origin strings.
   */
  allowedOrigins?: readonly string[]
}

/**
 * Decide whether to accept a `/trpc` WebSocket upgrade.
 *
 * Three admissions, each narrower than the blanket one it replaced:
 *
 *  1. **No `Origin` header → accept.** Browsers ALWAYS send `Origin` on a WS
 *     handshake, so its absence means the caller is not a browser: Electron main,
 *     node tooling, e2e, the sidecar, `slay`. Those cannot be confused deputies —
 *     they carry no ambient credentials for an attacker to borrow — and they are
 *     still bearer-gated afterwards. Accepting them here is what keeps every
 *     native client working on an enforcing hub — the desktop app included: its
 *     main process removes `Origin` from the app document's own `/trpc` sockets
 *     (app `hub-socket-origin.ts`), since its `file://` / dev-server origin is
 *     (rightly) refused below on a hub other machines reach.
 *
 *  2. **Local-client origins → accept only when the hub is local.** `file:`,
 *     `chrome:`, `chrome-extension:`, `devtools:` and `null` are first-party
 *     renderer origins. `null` is the dangerous one: `file://` serializes to it,
 *     but SO DOES ANY SANDBOXED IFRAME — `<iframe sandbox>` without
 *     `allow-same-origin` — which any website on the internet can embed. Blanket-
 *     accepting `null` therefore meant "accept every website" on an internet-facing
 *     hub. Gating these on `!requireLogin || loopbackBind` keeps the fork, the
 *     packaged app and dev loops working while closing that door for a hub anyone
 *     can reach.
 *
 *  3. **`localhost` origins → accept only when the hub binds loopback**, and
 *     `allowedOrigins` entries always. Note the comparison is on the FULL origin
 *     (scheme + host + port) for `allowedOrigins`; the previous implementation
 *     compared `hostname` alone, so `http://localhost:<any port>` was accepted and
 *     a hostile local dev server could open the socket.
 *
 * Unparseable input is rejected — fail closed.
 */
export function wsOriginDecision(opts: WsOriginOptions): WsOriginDecision {
  const { origin, requireLogin, loopbackBind } = opts
  const local = !requireLogin || loopbackBind

  // (1) Non-browser client.
  if (!origin) return 'accept'

  // An explicitly allowed origin wins regardless of shape — this is how a
  // browser-served web UI reaches its own hub. Exact string match, so a
  // lookalike host (`https://hub.example.com.evil.test`) cannot suffix its way in.
  if (opts.allowedOrigins?.includes(origin)) return 'accept'

  // (2) Opaque origin. `file://` AND every sandboxed iframe on the web.
  if (origin === 'null') return local ? 'accept' : 'reject'

  let u: URL
  try {
    u = new URL(origin)
  } catch {
    return 'reject'
  }

  if (LOCAL_CLIENT_PROTOCOLS.has(u.protocol)) return local ? 'accept' : 'reject'

  // (3) Loopback web origin.
  if (LOCAL_HOSTNAMES.has(u.hostname)) return loopbackBind ? 'accept' : 'reject'

  return 'reject'
}

export interface CookieOriginOptions {
  /** The request's `Origin` header (node hands back an array for a repeated one). */
  origin: string | string[] | undefined
  /** The request's `Host` header. */
  host: string | undefined
  /** See {@link WsOriginOptions.loopbackBind}. */
  loopbackBind: boolean
  /** {@link resolveAllowedWebOrigins}. */
  allowedOrigins: readonly string[]
}

/**
 * May a request authenticate by the web-session COOKIE (T-13) — a `/trpc` upgrade, a
 * state-changing REST call, sign-out? Only when its `Origin` is the hub's own page:
 *   - exactly one of `allowedOrigins` (the public address's origin, plus
 *     `SLAYZONE_HUB_ALLOWED_WEB_ORIGINS`), or
 *   - on a hub only this machine reaches, a loopback `http(s)` origin equal to the
 *     request's own `Host` — same origin.
 *
 * Stricter than {@link wsOriginDecision}, on purpose. That admits a request with NO
 * Origin (a native client: it carries no ambient credential) and the local-client
 * shapes; here the cookie IS the ambient credential, attached by the browser to
 * whatever asked. So a missing, `null`, repeated or unparseable Origin is refused (a
 * browser sends one on all of these requests — its absence means the cookie did not
 * come from the hub's page), and so is every local shape: `file:`, `chrome:`, and
 * another `localhost` port, which is the same SITE, so a `SameSite=Lax` cookie rides
 * along with its requests.
 */
export function cookieOriginDecision(opts: CookieOriginOptions): WsOriginDecision {
  const { origin } = opts
  if (typeof origin !== 'string' || !origin || origin === 'null') return 'reject'
  if (opts.allowedOrigins.includes(origin)) return 'accept'
  if (!opts.loopbackBind || !opts.host) return 'reject'
  let u: URL
  try {
    u = new URL(origin)
  } catch {
    return 'reject'
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'reject'
  if (!LOCAL_HOSTNAMES.has(u.hostname)) return 'reject'
  return u.host === opts.host.toLowerCase() ? 'accept' : 'reject'
}

/**
 * The exact origins this hub accepts beyond the local-client ones.
 *
 * DERIVED FIRST, configured second. A hub other machines can reach MUST declare
 * `SLAYZONE_HUB_PUBLIC_ADDRESS` (`startServer` refuses to boot otherwise) — that
 * is, by definition, the address a browser reaches it at. Deriving the origin
 * from it means a hub that serves a web UI needs no new configuration and cannot
 * have the two values drift apart.
 *
 * `SLAYZONE_HUB_ALLOWED_WEB_ORIGINS` is the escape hatch for the deployment the
 * derivation cannot see: a second hostname, or a reverse proxy terminating TLS on
 * a name that differs from the hub's own public address. Comma-separated, parsed
 * defensively (blank entries and unparseable values dropped) in the style of
 * `allowedRoots` in slayzone-config.ts.
 *
 * Each entry is normalized to a bare origin (`scheme://host[:port]`) so a value
 * with a trailing path or slash still matches what a browser actually sends.
 */
export function resolveAllowedWebOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const origins = new Set<string>()

  const publicAddress = env.SLAYZONE_HUB_PUBLIC_ADDRESS?.trim()
  if (publicAddress) {
    // Authority-only by grammar (host[:port], no scheme — see hub-addr.ts); the
    // scheme follows the host (A1): a front end serves TLS for anything that is not
    // loopback.
    const derived = normalizeOrigin(hubUrlFromAddr(publicAddress, 'http'))
    if (derived) origins.add(derived)
  }

  for (const raw of (env[HUB_ALLOWED_WEB_ORIGINS_ENV] ?? '').split(',')) {
    const normalized = normalizeOrigin(raw.trim())
    if (normalized) origins.add(normalized)
  }

  return [...origins]
}

/**
 * `scheme://host[:port]` for a parseable absolute http(s) URL, else null. Web origins
 * only: any other scheme (`file:`, `chrome-extension:`) has the OPAQUE origin "null",
 * which is also what every sandboxed iframe sends — allowing it would allow every
 * website, here and in better-auth's `trustedOrigins`.
 */
function normalizeOrigin(value: string): string | null {
  if (!value) return null
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null
  } catch {
    return null
  }
}
