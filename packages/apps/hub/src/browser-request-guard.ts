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
 *    under an attacker hostname, or from another origin. `Host` must name this machine
 *    or the hub's public address; a request that looks like a browser page
 *    (`Origin` or `Sec-Fetch-Site`) must be the hub's own page.
 *
 * Native clients send neither `Origin` nor `Sec-Fetch-Site` — Node's fetch (desktop
 * main, `slay`, the computer) sends only `sec-fetch-mode`, React Native sends none —
 * and the desktop renderer's hub sockets have their `Origin` removed by Electron main
 * (app `hub-socket-origin.ts`). So they are admitted, then gated by auth as before.
 *
 * Pure: `server.ts` wires it in front of `/api/*`, `/mcp` (incl. CLI-relayed
 * requests) and the `/trpc` upgrade.
 *
 * @module hub/browser-request-guard
 */
import { BROWSER_PANEL_REQUEST_HEADER } from '@slayzone/platform/browser-network'
import { wsOriginDecision } from './ws-origin.js'

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
  const h = host.trim().toLowerCase()
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

/** A request to `/api/*` or `/mcp`. */
export function apiRequestDecision(req: RequestLike, opts: BrowserGuardOptions): GuardDecision {
  if (header(req, BROWSER_PANEL_REQUEST_HEADER) !== undefined) return 'reject'
  const host = header(req, 'host')
  if (hostDecision(host, opts) === 'reject') return 'reject'
  const origin = header(req, 'origin')
  const site = header(req, 'sec-fetch-site')
  // A browser page is what sends `Sec-Fetch-Site` (every current browser), or an
  // `Origin` with no fetch metadata at all (an older one). Node's fetch sends
  // `Sec-Fetch-Mode` but never `Sec-Fetch-Site`, so a native client that sets an
  // `Origin` itself (better-auth's CSRF check wants one) stays native. Admitted; auth
  // gates it next.
  const browserPage =
    site !== undefined || (origin !== undefined && header(req, 'sec-fetch-mode') === undefined)
  if (!browserPage) return 'accept'
  if (origin !== undefined && opts.allowedOrigins.includes(origin)) return 'accept'
  // The hub's own page: same-origin fetch metadata, and an Origin (when sent) that is
  // this very host.
  const ownOrigin = origin === undefined || (host !== undefined && sameHostOrigin(origin, host))
  if (site === 'same-origin' && ownOrigin) return 'accept'
  // An older browser with no fetch metadata, same-origin by Origin.
  if (
    site === undefined &&
    origin !== undefined &&
    host !== undefined &&
    sameHostOrigin(origin, host)
  ) {
    return 'accept'
  }
  // A top-level GET navigation (a link, an SSO redirect back to the hub) cannot read
  // the response or change state.
  const method = (req.method ?? 'GET').toUpperCase()
  if (header(req, 'sec-fetch-mode') === 'navigate' && (method === 'GET' || method === 'HEAD')) {
    return 'accept'
  }
  return 'reject'
}

/** A `/trpc` WebSocket upgrade. */
export function trpcUpgradeDecision(req: RequestLike, opts: BrowserGuardOptions): GuardDecision {
  if (header(req, BROWSER_PANEL_REQUEST_HEADER) !== undefined) return 'reject'
  const host = header(req, 'host')
  if (hostDecision(host, opts) === 'reject') return 'reject'
  const origin = header(req, 'origin')
  if (origin === undefined) return 'accept'
  if (opts.allowedOrigins.includes(origin)) return 'accept'
  // The desktop app's hub: a loopback page is admitted only as the hub's own page.
  // Any other local port is just another website on this machine (its renderer's
  // sockets carry no Origin at all).
  if (opts.supervised) {
    let u: URL
    try {
      u = new URL(origin)
    } catch {
      return 'reject'
    }
    if (
      (u.protocol === 'http:' || u.protocol === 'https:') &&
      LOOPBACK_NAMES.has(hostnameOf(u.host))
    ) {
      return host !== undefined && sameHostOrigin(origin, host) ? 'accept' : 'reject'
    }
  }
  return wsOriginDecision({
    origin,
    requireLogin: opts.requireLogin,
    loopbackBind: opts.loopbackBind,
    allowedOrigins: opts.allowedOrigins
  })
}
