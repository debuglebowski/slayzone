/**
 * The hub's API is for native clients and the hub's OWN web page — never for any
 * other browser page.
 *
 * Two attacks this closes, both "a browser as confused deputy":
 *  - The loopback pivot: a remote hub or agent loads the desktop's login-off local
 *    hub (`http://127.0.0.1:51100`) into SlayZone's own browser panel and runs script
 *    there, same-origin with that hub — pty submit, file reads. Electron main stamps
 *    every panel-page request with {@link BROWSER_PANEL_REQUEST_HEADER}; it is
 *    refused here outright.
 *  - DNS rebinding / drive-by pages: any browser tab on the machine reaching the hub
 *    under an attacker hostname, or from another origin. `Host` must name this hub —
 *    a loopback name, an IP literal, or a name it is published under — on EVERY
 *    request: a rebound page's same-origin GET over http carries no `Origin` and no
 *    fetch metadata (browsers send `Sec-Fetch-*` only to https and localhost), so the
 *    absence of browser headers proves nothing. A request that looks like a browser
 *    page (`Origin` or `Sec-Fetch-Site`) must also be the hub's own page.
 *
 * Under any OTHER name only a provable native client gets through, and only on a hub
 * that requires login: one presenting a bearer (auth verifies it next — a page has
 * none of the user's), or signing in for one. A login-off hub (the desktop's) verifies
 * nothing, so nothing can be proved there: it answers to its own names only. Native
 * clients dial those anyway — desktop main, `slay`, the computer, the renderer's hub
 * sockets (whose `Origin` Electron main removes, app `hub-socket-origin.ts`).
 *
 * Pure: `server.ts` wires it in front of `/api/*`, `/mcp` (incl. CLI-relayed
 * requests) and the `/trpc` upgrade.
 *
 * @module hub/browser-request-guard
 */
import { BROWSER_PANEL_REQUEST_HEADER } from '@slayzone/platform/browser-network'
import { wsOriginDecision } from './ws-origin.js'
import { isSignInPath, routePathKey } from './rest-auth.js'

export type GuardDecision = 'accept' | 'reject'

export interface BrowserGuardOptions {
  /** Reachable only from this machine (loopback bind, no public address). */
  loopbackBind: boolean
  /** The desktop app's own hub. */
  supervised: boolean
  /** `SLAYZONE_HUB_REQUIRE_LOGIN`. */
  requireLogin: boolean
  /** Exact origins of the hub's own web page (`resolveAllowedWebOrigins`). */
  allowedOrigins: readonly string[]
  /** Hostnames this hub is published under (public address, allowed origins). */
  publicHosts: readonly string[]
}

interface RequestLike {
  method?: string
  headers: Record<string, string | string[] | undefined>
}

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1'])

const header = (req: RequestLike, name: string): string | undefined => {
  const v = req.headers[name]
  return Array.isArray(v) ? v[0] : v
}

/** The hostname of a `Host` header (`host[:port]`, `[v6]:port`), lower-cased. */
function hostnameOf(host: string): string {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/\.(?=:\d+$|$)/, '')
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']'))
  const colon = h.lastIndexOf(':')
  return colon > 0 && h.indexOf(':') === colon ? h.slice(0, colon) : h
}

const isIpLiteral = (h: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')

/**
 * The `Host` a request names must be this machine (a loopback name or any IP
 * literal — a rebind needs an attacker-controlled NAME) or one of the hub's public
 * hosts. Anything else is DNS rebinding.
 */
export function hostDecision(host: string | undefined, opts: BrowserGuardOptions): GuardDecision {
  if (!host) return 'reject'
  const name = hostnameOf(host)
  if (LOOPBACK_NAMES.has(name) || isIpLiteral(name)) return 'accept'
  return opts.publicHosts.some((p) => p.toLowerCase() === name) ? 'accept' : 'reject'
}

/** `Origin` is this very request's own origin (scheme irrelevant: same host:port). */
function sameHostOrigin(origin: string, host: string): boolean {
  try {
    return new URL(origin).host === host.toLowerCase()
  } catch {
    return false
  }
}

/** Why a request was refused — its own audit reason and a message that says what and why. */
export interface GuardRefusal {
  reason: 'browser-panel' | 'host' | 'origin'
  message: string
}

/**
 * Paths outside the guard: liveness only. EVERYTHING else — the API in any spelling
 * express routes (`/API`, `/Mcp/`, `//api`, encoded separators), the web shell, `/trpc`
 * over HTTP — is guarded: the decision fails closed.
 */
const PUBLIC_PATHS = new Set(['/health'])

export function isPublicPath(url: string | undefined): boolean {
  const key = routePathKey(url ?? '/')
  return key !== null && PUBLIC_PATHS.has(key)
}

const PANEL_REFUSAL: GuardRefusal = {
  reason: 'browser-panel',
  message:
    "Refused: this request comes from a page inside SlayZone's browser panel, which may not use a hub's API."
}

function hostRefusal(host: string | undefined): GuardRefusal {
  return {
    reason: 'host',
    message: `Refused: this hub is not published under the name "${host ?? ''}" (DNS rebinding protection). Reach it as localhost, by IP address or by its public address; to open the hub in a browser under that name, add its origin to SLAYZONE_HUB_ALLOWED_WEB_ORIGINS.`
  }
}

function originRefusal(origin: string | undefined): GuardRefusal {
  return {
    reason: 'origin',
    message: `Refused: a browser page from ${origin ? `"${origin}"` : 'another site'} is not this hub's own page.`
  }
}

/** A request looks like a browser page: `Sec-Fetch-Site` (every current browser), or an
 *  `Origin` with no fetch metadata at all (an older one). Node's fetch sends only
 *  `Sec-Fetch-Mode`, React Native and the computer relay send neither. */
function isBrowserPage(req: RequestLike): boolean {
  const origin = header(req, 'origin')
  return (
    header(req, 'sec-fetch-site') !== undefined ||
    (origin !== undefined && header(req, 'sec-fetch-mode') === undefined)
  )
}

/** Proves a native client on a login hub: a bearer (verified by auth next). */
const hasBearer = (req: RequestLike): boolean =>
  /^bearer\s+\S/i.test((header(req, 'authorization') ?? '').trim())

/**
 * Any HTTP request to the hub (not `/trpc` upgrades — {@link trpcUpgradeRefusal}).
 * Null = admitted (auth gates it next).
 */
export function httpRequestRefusal(
  req: RequestLike & { url?: string },
  opts: BrowserGuardOptions
): GuardRefusal | null {
  if (isPublicPath(req.url)) return null
  if (header(req, BROWSER_PANEL_REQUEST_HEADER) !== undefined) return PANEL_REFUSAL
  const host = header(req, 'host')
  if (hostDecision(host, opts) === 'reject') {
    // Another name: only a provable native client, on a hub that can verify one.
    const native =
      opts.requireLogin && !isBrowserPage(req) && (hasBearer(req) || isSignInPath(req.url))
    return native ? null : hostRefusal(host)
  }
  if (!isBrowserPage(req)) return null
  const origin = header(req, 'origin')
  const site = header(req, 'sec-fetch-site')
  if (origin !== undefined && opts.allowedOrigins.includes(origin)) return null
  // The hub's own page: same-origin fetch metadata, and an Origin (when sent) that is
  // this very host.
  const ownOrigin = origin === undefined || (host !== undefined && sameHostOrigin(origin, host))
  if (site === 'same-origin' && ownOrigin) return null
  // An older browser with no fetch metadata, same-origin by Origin.
  if (
    site === undefined &&
    origin !== undefined &&
    host !== undefined &&
    sameHostOrigin(origin, host)
  ) {
    return null
  }
  // A top-level GET navigation (a link, an SSO redirect back to the hub, the address
  // bar) cannot read the response or change state.
  const method = (req.method ?? 'GET').toUpperCase()
  if (header(req, 'sec-fetch-mode') === 'navigate' && (method === 'GET' || method === 'HEAD')) {
    return null
  }
  return originRefusal(origin)
}

/**
 * A `/trpc` WebSocket upgrade. Null = admitted. A login-off hub answers to its own
 * names only. On a login hub a socket with no `Origin` is positively not a browser's
 * (a browser always sends it on a WebSocket handshake; a page cannot remove it) and
 * signs in over the socket next, so it may use any name.
 */
export function trpcUpgradeRefusal(
  req: RequestLike,
  opts: BrowserGuardOptions
): GuardRefusal | null {
  if (header(req, BROWSER_PANEL_REQUEST_HEADER) !== undefined) return PANEL_REFUSAL
  const origin = header(req, 'origin')
  const host = header(req, 'host')
  const ownHost = hostDecision(host, opts) === 'accept'
  if (origin === undefined) return ownHost || opts.requireLogin ? null : hostRefusal(host)
  if (!ownHost) return hostRefusal(host)
  if (opts.allowedOrigins.includes(origin)) return null
  // The desktop app's hub: a loopback page is admitted only as the hub's own page.
  // Any other local port is just another website on this machine (its renderer's
  // sockets carry no Origin at all).
  if (opts.supervised) {
    let u: URL
    try {
      u = new URL(origin)
    } catch {
      return originRefusal(origin)
    }
    if (
      (u.protocol === 'http:' || u.protocol === 'https:') &&
      LOOPBACK_NAMES.has(hostnameOf(u.host))
    ) {
      return host !== undefined && sameHostOrigin(origin, host) ? null : originRefusal(origin)
    }
  }
  return wsOriginDecision({
    origin,
    requireLogin: opts.requireLogin,
    loopbackBind: opts.loopbackBind,
    allowedOrigins: opts.allowedOrigins
  }) === 'accept'
    ? null
    : originRefusal(origin)
}

/** {@link httpRequestRefusal} as accept/reject, for an `/api` request by default. */
export function apiRequestDecision(
  req: RequestLike & { url?: string },
  opts: BrowserGuardOptions
): GuardDecision {
  return httpRequestRefusal({ ...req, url: req.url ?? '/api/x' }, opts) ? 'reject' : 'accept'
}

/** {@link trpcUpgradeRefusal} as accept/reject. */
export function trpcUpgradeDecision(req: RequestLike, opts: BrowserGuardOptions): GuardDecision {
  return trpcUpgradeRefusal(req, opts) ? 'reject' : 'accept'
}
