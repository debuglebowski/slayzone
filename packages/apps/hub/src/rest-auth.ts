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

/**
 * What to do with an inbound HTTP request:
 *   - `allow`  — pass straight through (gate off, exempt route, or loopback peer)
 *   - `verify` — require a valid bearer; 401 when absent/invalid
 */
export type RestAuthAction = 'allow' | 'verify'

/**
 * better-auth's OWN route prefix. Must stay open even on an enforcing hub: it is
 * how a client OBTAINS a token in the first place (sign-in/sign-up/get-session),
 * so gating it would make the hub unauthenticatable. Note this is a strict prefix
 * check WITH the trailing slash — `/api/authx/...` and a bare `/api/auth` are NOT
 * bootstrap routes and stay guarded.
 *
 * Our own `/api/auth/deep-link` (registerAuthDeepLinkRoute) lives under the same
 * path prefix but is NOT better-auth's, so it is listed as a re-guarded exception
 * below — an off-box caller must not inject an OAuth callback code into the
 * authEvents bus.
 */
const AUTH_BOOTSTRAP_PREFIX = '/api/auth/'

/** Paths under {@link AUTH_BOOTSTRAP_PREFIX} that are ours, not better-auth's. */
const NOT_BOOTSTRAP = new Set<string>(['/api/auth/deep-link'])

/**
 * Routes that carry their OWN stronger guard and must not additionally require a
 * bearer.
 *
 * `/api/runners/join-token`: the Electron MAIN process mints a token over
 * loopback at boot to auto-enroll the co-located runner, and main has no session
 * (no tRPC client, no credentials) — requiring a bearer would break local-runner
 * auto-enroll on an otherwise-enforcing hub. The route self-guards on loopback OR
 * a verified bearer (see its `joinTokenAuthDecision`), which is still at least as
 * tight as this gate: an off-box caller is admitted only on the same authority
 * `/trpc` already accepts for the identical `runners.mintJoinToken` operation.
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
const SELF_GUARDED = new Set<string>(['/api/runners/join-token', '/api/hub/users'])

/** The MCP tool endpoint — same power as the tRPC router, so same gating. */
const MCP_PATH = '/mcp'

/** True for IPv4/IPv6 loopback, incl. the IPv4-mapped-IPv6 form node reports. */
function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false
  return addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.')
}

export interface RestAuthActionOptions {
  /** Whether THIS hub enforces auth (`isRemoteMode() && hubAuth != null`). */
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
 * co-located process: the Electron host, the supervised runner, a task terminal's
 * `slay`), and the exempt paths documented above.
 *
 * Only `/api/*` and `/mcp` are gated at all. `/health` is answered pre-express
 * and `/trpc` is a WS upgrade that never reaches this handler; any other path
 * 404s in express regardless, so gating them would add nothing.
 */
export function restAuthAction(opts: RestAuthActionOptions): RestAuthAction {
  if (!opts.hubAuthRequired) return 'allow'
  // A co-located caller is inside the trust boundary the loopback bind already
  // established; keeping it open is what makes an enforcing hub byte-identical
  // for the desktop host, the supervised runner, and in-task `slay` calls.
  if (isLoopbackAddress(opts.remoteAddress)) return 'allow'
  // No url at all → cannot prove the route is exempt, so demand a bearer.
  if (!opts.url) return 'verify'
  const path = opts.url.split('?')[0]
  if (path !== MCP_PATH && !path.startsWith('/api/')) return 'allow'
  if (SELF_GUARDED.has(path)) return 'allow'
  if (path.startsWith(AUTH_BOOTSTRAP_PREFIX) && !NOT_BOOTSTRAP.has(path)) return 'allow'
  return 'verify'
}

/**
 * Verify an `Authorization: Bearer <token>` header against the hub's better-auth
 * sessions. This is the same `verifySession` authority the tRPC connection uses,
 * reached over a header instead of `connectionParams`.
 *
 * Fail-closed + fail-quiet, so a caller can only ever get `true` for a genuinely
 * valid session: a null `auth`, an absent/blank/duplicated header, a non-Bearer
 * scheme, or a throw inside verify all yield `false`. A DUPLICATED header
 * (node hands back `string[]`) is rejected rather than resolved by picking one —
 * an ambiguous credential must not authenticate.
 */
export async function verifyRestBearer(
  auth: HubAuth | null,
  headers: IncomingHttpHeaders
): Promise<boolean> {
  if (!auth) return false
  const raw = headers.authorization
  if (typeof raw !== 'string') return false
  const match = /^Bearer[ ]+(.+)$/i.exec(raw.trim())
  const token = match?.[1]?.trim()
  if (!token) return false
  try {
    const ctx = await verifySession(auth, new Headers({ authorization: `Bearer ${token}` }))
    return ctx != null
  } catch {
    return false
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
  next: (req: IncomingMessage, res: ServerResponse) => void
}): (req: IncomingMessage, res: ServerResponse) => void {
  const deny = (res: ServerResponse): void => {
    if (res.headersSent) return
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'Unauthorized' }))
  }
  return (req, res) => {
    const action = restAuthAction({
      hubAuthRequired: opts.getHubAuthRequired(),
      url: req.url,
      remoteAddress: req.socket.remoteAddress ?? undefined
    })
    if (action === 'allow') {
      opts.next(req, res)
      return
    }
    void verifyRestBearer(opts.getHubAuth(), req.headers)
      .then((ok) => (ok ? opts.next(req, res) : deny(res)))
      .catch(() => deny(res))
  }
}
