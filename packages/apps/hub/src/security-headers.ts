/**
 * Security headers on every HTTP response the hub sends (G-17).
 *
 * ONE chokepoint: `withSecurityHeaders` wraps the handler `createServer` is given,
 * so a response gets these headers whichever handler writes it — `/health`,
 * better-auth (`/api/auth/*`), REST and MCP (`/api/*`, `/mcp`), the web shell and
 * its assets, and express's own 404 and error pages. It hooks the response's
 * `writeHead`, which Node also calls for an implicit header (from `write`, `end`,
 * `flushHeaders`), so it sees the route's final headers just before they are
 * serialized.
 *
 * Not covered: WebSocket upgrades (`/trpc`, `/computers`). Their 101 or 403 is
 * written straight to the socket by the `upgrade` handler, never through a
 * ServerResponse, and is not a document.
 *
 * Two profiles, split on the same paths `web-assets.ts` leaves to other handlers:
 *   - API (`/api`, `/mcp`, `/trpc`, `/computers`, `/health`): JSON, tokens, user
 *     data. `Cache-Control: no-store` and a CSP under which nothing loads.
 *   - Web shell (every other path): the SPA document, its hashed assets and its
 *     worker. A worker's CSP comes from its own script's response, so assets get
 *     the shell policy too. Caching stays as `web-assets.ts` sets it.
 *
 * The security headers win over a route's own value (no route sets one today).
 * Everything else a route sets on purpose is kept: `Cache-Control` is only a
 * default outside the API. No CORS headers here.
 *
 * Desktop hub: same code, no switch. The only difference is HSTS, which needs an
 * https public address, so a loopback hub never sends it.
 *
 * @module server/security-headers
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { hubUrlFromAddr, isLoopbackAuthority } from '@slayzone/platform/hub-addr'
import { isReservedUrl } from './web-assets.js'

/**
 * PostHog EU, as the web shell's posthog-js contacts it: events and `/flags` go to
 * the ingestion host, the remote config JSON (`/array/<key>/config`) to the assets
 * host (`RequestRouter.endpointFor` maps `eu.i.posthog.com` to both). Must follow
 * the web shell build's `__POSTHOG_HOST__` default (`apps/web-shell/vite.config.ts`);
 * `security-headers.test.ts` checks it does. A build pointed at another PostHog host
 * has its telemetry blocked here.
 *
 * Connect only, never script: posthog-js is told not to load remote scripts
 * (`disable_external_dependency_loading`, telemetry.ts), so no third-party code
 * runs in the hub's origin, where the session token lives.
 */
export const POSTHOG_ORIGINS = ['https://eu.i.posthog.com', 'https://eu-assets.i.posthog.com']

/**
 * GitHub avatars, which the linked-PR view renders (`worktrees/client/pr-avatars.tsx`).
 * `github.com/<login>.png` answers with a redirect to `avatars.githubusercontent.com`,
 * and CSP checks every hop, so both. A blocked avatar falls back to initials.
 */
export const GITHUB_AVATAR_ORIGINS = ['https://github.com', 'https://avatars.githubusercontent.com']

/**
 * Entra sign-in. Chrome applies `form-action` to every redirect after a form POST,
 * so a sign-in started by a form that answers 302 to Entra would be blocked by
 * `'self'` alone. T-09 starts sign-in by `fetch` (no form), so this only keeps a
 * form-based button working.
 */
export const ENTRA_SIGN_IN_ORIGIN = 'https://login.microsoftonline.com'

/**
 * The web shell document's policy.
 *
 * `style-src 'unsafe-inline'`: xterm, Radix (react-remove-scroll), sonner and mermaid
 * inject `<style>` at run time; inline style cannot run script. The
 * desktop renderer runs the same tree under the same rule (`renderer-csp.ts`).
 *
 * `connect-src`: `'self'` covers same-origin fetches and, in CSP Level 3, the
 * same-origin `ws:`/`wss:` of `/trpc`. The public address is named as well, derived
 * from config and never from a request header, for browsers that still do not
 * match a websocket on `'self'`.
 */
export function webShellCsp(publicAddress: string | undefined): string {
  const connect = ["'self'"]
  if (publicAddress !== undefined) connect.push(hubUrlFromAddr(publicAddress, 'ws'))
  connect.push(...POSTHOG_ORIGINS)
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${GITHUB_AVATAR_ORIGINS.join(' ')}`,
    `connect-src ${connect.join(' ')}`,
    "object-src 'none'",
    "base-uri 'none'",
    `form-action 'self' ${ENTRA_SIGN_IN_ORIGIN}`,
    "frame-ancestors 'none'"
  ].join('; ')
}

/**
 * Every API response: nothing loads. The one HTML page the API serves is
 * better-auth's `/api/auth/error` (outside NODE_ENV=production), which is styled
 * only by inline styles, hence `style-src 'unsafe-inline'`.
 */
export const API_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

/**
 * One year, no `includeSubDomains`: the hub owns its host, not the names under it.
 * Only when the public address is https, i.e. not loopback (rule A1). The browser
 * ignores HSTS on plain http, and a loopback hub must never pin a scheme.
 */
export function strictTransportSecurity(publicAddress: string | undefined): string | null {
  if (publicAddress === undefined || isLoopbackAuthority(publicAddress)) return null
  return 'max-age=31536000'
}

export interface SecurityHeadersOptions {
  /** `SLAYZONE_HUB_PUBLIC_ADDRESS` (`host[:port]`, B8-validated); undefined on a hub nobody else reaches. */
  publicAddress: string | undefined
}

interface Profile {
  /** Set on every response, over any value the route chose. */
  forced: ReadonlyArray<readonly [string, string]>
  /** Set only when the route chose none. */
  defaults: ReadonlyArray<readonly [string, string]>
  /** Lower-case names taken out of a `writeHead` header argument (forced ones + removed ones). */
  strip: ReadonlySet<string>
}

/** Express adds it; it names the stack and serves nothing. */
const REMOVED = ['x-powered-by']

function buildProfiles(opts: SecurityHeadersOptions): { api: Profile; shell: Profile } {
  const common: Array<[string, string]> = [
    ['x-content-type-options', 'nosniff'],
    // Legacy twin of `frame-ancestors 'none'`.
    ['x-frame-options', 'DENY'],
    // Full referrer within the hub, none to PostHog/GitHub/Entra. Not `no-referrer`:
    // under it a same-origin `fetch` POST carries `Origin: null`, which fails
    // better-auth's origin check.
    ['referrer-policy', 'same-origin']
  ]
  const hsts = strictTransportSecurity(opts.publicAddress)
  if (hsts) common.push(['strict-transport-security', hsts])
  const profile = (
    forced: Array<[string, string]>,
    defaults: Array<[string, string]>
  ): Profile => ({
    forced,
    defaults,
    strip: new Set([...forced.map(([name]) => name), ...REMOVED])
  })
  return {
    api: profile(
      [...common, ['content-security-policy', API_CSP], ['cache-control', 'no-store']],
      []
    ),
    shell: profile(
      [...common, ['content-security-policy', webShellCsp(opts.publicAddress)]],
      // `web-assets.ts` sets its own (index `no-cache`, hashed assets immutable);
      // this covers what falls through to express (a 404, a POST to `/`).
      [['cache-control', 'no-store']]
    )
  }
}

type HeaderArg = Record<string, unknown> | unknown[]

/** Lower-case header names in a `writeHead` header argument (object, flat or nested array). */
function headerNames(headers: HeaderArg): Set<string> {
  if (!Array.isArray(headers)) return new Set(Object.keys(headers).map((k) => k.toLowerCase()))
  const names = new Set<string>()
  if (Array.isArray(headers[0])) {
    for (const pair of headers as unknown[][]) names.add(String(pair[0]).toLowerCase())
  } else {
    for (let i = 0; i < headers.length; i += 2) names.add(String(headers[i]).toLowerCase())
  }
  return names
}

/** A copy of a `writeHead` header argument without the named headers, shape kept. */
function withoutHeaders(headers: HeaderArg, drop: ReadonlySet<string>): HeaderArg {
  if (!Array.isArray(headers)) {
    return Object.fromEntries(Object.entries(headers).filter(([k]) => !drop.has(k.toLowerCase())))
  }
  if (Array.isArray(headers[0])) {
    return (headers as unknown[][]).filter((pair) => !drop.has(String(pair[0]).toLowerCase()))
  }
  const out: unknown[] = []
  for (let i = 0; i + 1 < headers.length; i += 2) {
    if (!drop.has(String(headers[i]).toLowerCase())) out.push(headers[i], headers[i + 1])
  }
  return out
}

function applyProfile(res: ServerResponse, profile: Profile, args: unknown[]): void {
  // writeHead(status, [message], [headers]). Node merges a headers argument OVER
  // values set with setHeader, so a forced header is taken out of it and set here.
  const last = args.length > 1 ? args[args.length - 1] : undefined
  const headerArg = typeof last === 'object' && last !== null ? (last as HeaderArg) : null
  const passed = headerArg ? headerNames(headerArg) : new Set<string>()
  if (headerArg) args[args.length - 1] = withoutHeaders(headerArg, profile.strip)
  for (const name of REMOVED) res.removeHeader(name)
  for (const [name, value] of profile.forced) res.setHeader(name, value)
  for (const [name, value] of profile.defaults) {
    if (!res.hasHeader(name) && !passed.has(name)) res.setHeader(name, value)
  }
}

/**
 * Wrap the hub's request handler so every response it writes carries the security
 * headers (see the module comment). `server.ts` calls this once, on the handler it
 * passes to `createServer`.
 */
export function withSecurityHeaders(
  next: (req: IncomingMessage, res: ServerResponse) => void,
  opts: SecurityHeadersOptions
): (req: IncomingMessage, res: ServerResponse) => void {
  const profiles = buildProfiles(opts)
  return (req, res) => {
    const profile = isReservedUrl(req.url) ? profiles.api : profiles.shell
    const writeHead = res.writeHead
    res.writeHead = function (this: ServerResponse, ...args: unknown[]) {
      if (!this.headersSent) applyProfile(this, profile, args)
      return (writeHead as (...a: unknown[]) => ServerResponse).apply(this, args)
    } as ServerResponse['writeHead']
    next(req, res)
  }
}
