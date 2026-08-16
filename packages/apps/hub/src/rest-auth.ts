/**
 * Bearer gate for the hub's HTTP surface (`/api/*` + `/mcp`) — the HTTP-side twin
 * of `hub-trpc-context.ts`.
 *
 * WHY THIS EXISTS: `setAuthGate` gates the tRPC router, but the SAME muxed
 * listener also serves the entire REST surface the `slay` CLI drives (tasks,
 * artifacts, pty write/submit, browser eval, automations) plus the `/mcp` tool
 * endpoint, and `createMcpRestApp` mounts nothing but `express.json()`. Under
 * `SLAYZONE_MODE=remote` that listener IS the internet-facing https one, so those
 * routes were reachable unauthenticated — while the CLI was already sending an
 * `Authorization: Bearer` header (from `SLAYZONE_HUB_TOKEN` or `cli-hub-target.json`) that
 * no one verified. This module makes that header load-bearing.
 *
 * Shape mirrors `hub-trpc-context.ts` deliberately: the security-relevant
 * decisions are PURE functions here, unit-tested without the full `startServer`
 * boot (composeServer → better-auth migrations → two listeners). `server.ts`
 * keeps only the wiring.
 *
 * INERT WHEN AUTH IS OFF: `hubAuthRequired` is the same derived flag the tRPC
 * gate uses (`isRemoteMode() && hubAuth != null`). Local / supervised / e2e hubs
 * leave it false → every request short-circuits to `allow` with no verify call,
 * byte-identical to the trusted-loopback path.
 *
 * @module server/rest-auth
 */
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import type { HubAuth } from '@slayzone/hub-auth/server'
import { verifySession } from '@slayzone/hub-auth/server'
import { isLoopbackPeer, type SlayzoneDb } from '@slayzone/platform'
import type { RestPrincipal } from '@slayzone/transport/server'
import { isWebSessionToken, verifyWebSessionToken, WEB_SESSION_COOKIE_NAME } from './web-sessions'

/**
 * What to do with an inbound HTTP request:
 *   - `allow`  — pass straight through (gate off, exempt route, or loopback peer)
 *   - `verify` — require a valid bearer; 401 when absent/invalid
 */
export type RestAuthAction = 'allow' | 'verify'

/**
 * The EXACT better-auth routes that must stay open on an enforcing hub, because
 * they are how a client with no token obtains one.
 *
 * WAS A PREFIX, NOW AN ALLOWLIST. `/api/auth/` used to be exempted wholesale with
 * a small denylist. That is fail-OPEN by construction: every route better-auth or
 * any of its plugins mounts under that prefix — present and future — was
 * unauthenticated. Concretely, the `apiKey()` plugin mounts
 * `POST /api/auth/api-key/create`, which turned into a computer-impersonation
 * escalation (see `verifyComputerApiKey`), and the `organization()` and `jwt()`
 * plugins mount member/invite and token/JWKS routes that nothing in SlayZone
 * reads. Enumerating what is genuinely needed is the only version of this that
 * stays correct when a dependency adds a route.
 *
 * The four below are exactly what `hubSignIn` (CLI) and a browser session need:
 *   - `sign-in/email`  — obtain a FULL session. Sign-UP is deliberately absent;
 *                        `emailAndPassword.disableSignUp` also refuses it at the
 *                        source, so this is belt-and-braces.
 *   - `sign-out`       — revoke one, which a client must be able to do while
 *                        holding a token the hub may already consider invalid.
 *   - `get-session`    — probe validity. Answers "no" unauthenticated by design.
 *   - `web-login`      — OURS, not better-auth's (registerWebLoginRoute). Obtain
 *                        a SCOPED session instead: it calls `sign-in/email`
 *                        server-side and discards the full session it returns,
 *                        so a browser never holds `full` for even one request.
 *                        See `web-sessions.ts` for why that distinction exists.
 *
 * Matching is EXACT, so `/api/auth/sign-in/email/extra` inherits nothing. Adding
 * a route here is a security decision: it makes that route reachable by anyone
 * who can reach the hub.
 */
const AUTH_BOOTSTRAP_PATHS = new Set<string>([
  '/api/auth/sign-in/email',
  '/api/auth/sign-out',
  '/api/auth/get-session',
  '/api/auth/web-login'
])

/**
 * Routes that carry their OWN stronger guard and must not additionally require a
 * bearer.
 *
 * `/api/computers/join-token`: the Electron MAIN process mints a token over
 * loopback at boot to auto-enroll the co-located computer, and main has no session
 * (no tRPC client, no credentials) — requiring a bearer would break local-computer
 * auto-enroll on an otherwise-enforcing hub. The route self-guards on loopback OR
 * a verified bearer (see its `joinTokenAuthDecision`), which is still at least as
 * tight as this gate: an off-box caller is admitted only on the same authority
 * `/trpc` already accepts for the identical `computers.mintJoinToken` operation.
 * Keeping the exemption is what preserves that route's own status codes — gating
 * here would 401 an off-box request before it could report the 503 (listener not
 * yet bound) or the 403 that says "wrong machine" rather than "no credential".
 *
 * `/api/hub/users`: backs `slay hub users add|ls|rm`, which an operator runs ON the
 * hub box (typically over SSH) and which holds no session. Requiring a bearer would
 * make it impossible to create the FIRST account on a remote hub — and since
 * `emailAndPassword.disableSignUp` closes public signup, that hub would be
 * permanently unauthenticatable. Same protection as above: the route 403s every
 * non-loopback peer, so a shell on the box is the credential.
 *
 * EXACT-PATH matching is load-bearing for both: `restAuthAction` compares the
 * pathname verbatim, so a nested path (`/api/hub/users/extra`) does NOT inherit the
 * exemption. Any future route needing this must be listed here in full — which is
 * also why the user routes put the target email in the request body rather than in
 * a `/:email` path segment.
 */
const SELF_GUARDED = new Set<string>(['/api/computers/join-token', '/api/hub/users'])

/** The MCP tool endpoint — same power as the tRPC router, so same gating. */
const MCP_PATH = '/mcp'

export interface RestAuthActionOptions {
  /** Supervised hubs are the only ones that keep the loopback exemption — see
   *  `restAuthAction`. Absent = standalone, i.e. no exemption. */
  supervised?: boolean
  /** Whether THIS hub enforces auth (`!supervised`, see `server.ts`). */
  hubAuthRequired: boolean
  /** The raw request url (`req.url`), query string included. */
  url: string | undefined
  /** The peer address (`req.socket.remoteAddress`). Unknown → treated as off-box. */
  remoteAddress: string | undefined
}

/**
 * Decide whether a request must present a verified bearer.
 *
 * Fail-CLOSED by default once the hub enforces auth: an unparseable/absent url or
 * an unknown peer address resolves to `verify`, never `allow`. The only openings
 * are the three deliberate ones — the gate being off, a loopback peer (a
 * co-located process: the Electron host, the supervised computer, a task terminal's
 * `slay`), and the exempt paths documented above.
 *
 * Only `/api/*` and `/mcp` are gated at all. `/health` is answered pre-express
 * and `/trpc` is a WS upgrade that never reaches this handler; any other path
 * 404s in express regardless, so gating them would add nothing.
 */
export function restAuthAction(opts: RestAuthActionOptions): RestAuthAction {
  if (!opts.hubAuthRequired) return 'allow'
  // A co-located caller is inside the trust boundary the loopback bind already
  // established — but ONLY on a supervised hub, where that bind is asserted and
  // the Electron host owns the process. On a standalone hub this exemption was
  // the real fail-open: with auth now required on every non-supervised hub, an
  // unconditional loopback pass made the gate inert exactly where it started to
  // matter. Standalone loopback callers present a bearer like anyone else; the
  // CLI already has the plumbing for one.
  //
  // REACHABILITY: `server.ts` derives `hubAuthRequired = !supervised`, so in
  // production this branch is UNREACHABLE — a supervised hub already returned
  // 'allow' on the line above. It is kept, and passed explicitly rather than
  // re-derived, so a future supervised-but-authed hub (e.g. a multi-user desktop)
  // keeps this exemption BY DECISION rather than by accident. Tests that pin
  // `supervised: true` alongside `hubAuthRequired: true` exercise that
  // hypothetical, not a shape the hub can currently be in.
  if (opts.supervised && isLoopbackPeer(opts.remoteAddress)) return 'allow'
  // No url at all → cannot prove the route is exempt, so demand a bearer.
  if (!opts.url) return 'verify'
  const path = opts.url.split('?')[0]
  if (path !== MCP_PATH && !path.startsWith('/api/')) return 'allow'
  if (SELF_GUARDED.has(path)) return 'allow'
  if (AUTH_BOOTSTRAP_PATHS.has(path)) return 'allow'
  return 'verify'
}

/** Extract a bearer token from `Authorization: Bearer <token>`. Null for
 *  anything else — absent header, non-Bearer scheme, blank token, or a
 *  DUPLICATED header (node hands back `string[]` for a repeated header, which
 *  is rejected rather than resolved by picking one — an ambiguous credential
 *  must not authenticate). */
function extractBearerToken(headers: IncomingHttpHeaders): string | null {
  const raw = headers.authorization
  if (typeof raw !== 'string') return null
  const match = /^Bearer[ ]+(.+)$/i.exec(raw.trim())
  return match?.[1]?.trim() || null
}

/**
 * Parse a `Cookie` header into a name→value map. Minimal on purpose — no
 * attribute parsing (this only ever reads the header a browser SENDS, which
 * carries name=value pairs only, never `Set-Cookie`'s attributes).
 */
export function parseCookieHeader(headers: IncomingHttpHeaders): Record<string, string> {
  const raw = headers.cookie
  if (typeof raw !== 'string') return {}
  const out: Record<string, string> = {}
  for (const pair of raw.split(';')) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    const name = pair.slice(0, eq).trim()
    if (!name) continue
    out[name] = decodeURIComponent(pair.slice(eq + 1).trim())
  }
  return out
}

/**
 * Resolve a REST-side principal from a request's credentials. This is the
 * twin of `resolveConnectionPrincipal` (`hub-trpc-context.ts`) for `/api/*` —
 * same two credential classes, same fail-closed/fail-quiet shape, reached over
 * headers instead of a tRPC connect frame.
 *
 * TWO CREDENTIAL CLASSES, checked in a specific order:
 *   1. A `szw_`-prefixed value — from EITHER the bearer header OR the
 *      `slayzone_web_session` cookie — is looked up in `web_sessions` and
 *      resolves to that row's OWN `scopes`. Checked FIRST and by prefix alone,
 *      so a scoped token is never even tried against `verifySession`.
 *   2. Anything else in the BEARER HEADER (never the cookie — see below) is
 *      checked against `verifySession`, resolving to `['full']` on success.
 *
 * COOKIES ARE NEVER CONSULTED FOR THE FULL PATH. A cookie is automatically
 * attached by the browser to every request to this origin, which is exactly
 * the CSRF shape — an attacker's page can trigger a request that carries it,
 * but cannot read or forge an `Authorization` header cross-origin. Restricting
 * cookie-based auth to the ONE credential class that is scope-limited by
 * construction (never `full`) bounds what a forged request could do even
 * before the origin check in `ws-origin.ts` (whose REST-side counterpart is
 * `restAuthAction`'s own path/loopback logic) is considered.
 *
 * Returns `null` for anything but a clean hit — absent/blank/duplicated
 * header, unknown/expired/revoked web session, invalid better-auth session, a
 * null `auth`, or a throw inside either verify path.
 */
export async function verifyRestBearer(
  auth: HubAuth | null,
  db: SlayzoneDb | null,
  headers: IncomingHttpHeaders,
  cookies: Record<string, string> = {}
): Promise<RestPrincipal | null> {
  const bearerToken = extractBearerToken(headers)
  const cookieToken = cookies[WEB_SESSION_COOKIE_NAME]
  const webToken =
    bearerToken && isWebSessionToken(bearerToken)
      ? bearerToken
      : cookieToken && isWebSessionToken(cookieToken)
        ? cookieToken
        : null

  if (webToken) {
    if (!db) return null
    try {
      const result = await verifyWebSessionToken(db, webToken)
      return result.ok ? { userId: result.userId, scopes: result.scopes } : null
    } catch {
      return null
    }
  }

  // Not a szw_ token — the ONLY remaining path is a real better-auth bearer,
  // and ONLY from the header (see the docstring's CSRF reasoning).
  if (!auth || !bearerToken) return null
  try {
    const ctx = await verifySession(auth, new Headers({ authorization: `Bearer ${bearerToken}` }))
    return ctx ? { userId: ctx.userId, orgId: ctx.orgId, scopes: ['full'] } : null
  } catch {
    return null
  }
}

/**
 * Wrap a request handler in the bearer gate. `server.ts` calls this ONCE and
 * mounts the result, so the allow/verify/401 sequencing lives here (tested)
 * rather than inline in the boot path.
 *
 * The gate sits ABOVE the desktop reverse-proxy on purpose: those routes
 * (`/api/browser/*`, artifact exports) drive live WebContents — arbitrary JS eval
 * in a real browser view — so they are the LAST thing that should reach the
 * desktop app unauthenticated.
 *
 * Never throws and always terminates the response: `verifyRestBearer` is already
 * fail-quiet, and the `.catch` is a belt-and-braces guard so no future refactor
 * can leave a socket hanging open.
 */
export function withRestAuth(opts: {
  getHubAuthRequired: () => boolean
  getHubAuth: () => HubAuth | null
  /** Needed to resolve a `szw_` web-session token — null on a host with no
   *  such table available (there is none today; kept optional for callers
   *  that genuinely have no DB, e.g. a future capability-only test double). */
  getDb: () => SlayzoneDb | null
  next: (req: IncomingMessage, res: ServerResponse) => void
}): (req: IncomingMessage, res: ServerResponse) => void {
  const deny = (res: ServerResponse, code: 401 | 403, message: string): void => {
    if (res.headersSent) return
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: message }))
  }
  return (req, res) => {
    const action = restAuthAction({
      supervised: process.env.SLAYZONE_SUPERVISED === '1',
      hubAuthRequired: opts.getHubAuthRequired(),
      url: req.url,
      remoteAddress: req.socket.remoteAddress ?? undefined
    })
    if (action === 'allow') {
      opts.next(req, res)
      return
    }
    const cookies = parseCookieHeader(req.headers)
    void verifyRestBearer(opts.getHubAuth(), opts.getDb(), req.headers, cookies)
      .then((principal) => {
        if (!principal) {
          deny(res, 401, 'Unauthorized')
          return
        }
        // A scoped web session is deliberately GIVEN NO REST ACCESS in Phase 1
        // — the granular per-route scope map that would make a narrower grant
        // safe does not exist for `/api/*` the way `SCOPE_POLICY` does for
        // `/trpc` (see scopes.ts). Denying categorically here is the twin
        // `rest-auth.ts`'s own docstring calls for: the SAME operation (e.g.
        // `pty.write`) must not be reachable through REST when tRPC's scope
        // gate would refuse it, and REST simply has no scope gate of its own
        // yet — so `full` is the only principal class this surface accepts.
        // 403, not 401: the credential is real, just the wrong class for this
        // door — a distinction worth preserving for whoever reads the log.
        if (!principal.scopes.includes('full')) {
          deny(res, 403, 'a scoped web session cannot use the REST API — use /trpc instead')
          return
        }
        opts.next(req, res)
      })
      .catch(() => deny(res, 401, 'Unauthorized'))
  }
}
