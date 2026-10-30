import type { IncomingMessage, ServerResponse } from 'node:http'
import { isLoopbackPeer } from '@slayzone/platform/hub-addr'
import type { HubSwitches } from '@slayzone/platform/hub-switches'
import { getServerBuildInfo } from './build-info.js'

export type HealthState = {
  ready: boolean
  port: number
  startedAt: number
  dbPath: string
  /** Operator-facing hub name — `slay hub ls`/`stop` address a hub by this. */
  name: string
  /** The hub's SLAYZONE_ROOT anchor (config + storage + logs all derive from it). */
  root: string
  /** This process's pid, so a discovering CLI can signal the REAL hub (not an
   *  `npx` wrapper) without any pidfile. */
  pid: number
  /** True when started by the desktop app. `slay hub stop` refuses these: the app
   *  owns its own sidecar's lifecycle. Says nothing about login — read
   *  `authRequired` for that. */
  supervised: boolean
  /** Whether this hub gates its client API (`/trpc` + REST) on a bearer token —
   *  the `SLAYZONE_HUB_REQUIRE_LOGIN` switch. This is where `slay` learns whether
   *  it needs a credential. */
  authRequired: boolean
  /** Every per-hub switch (login, password, SSO, processes, integrations), so a
   *  client can tell what this hub offers before it signs in. */
  switches: HubSwitches
  /** Boot rule B13: other machines can reach this hub (it listens off-loopback or
   *  has a public address). A reverse proxy on THIS machine delivers every remote
   *  request from a loopback socket, so on such a hub "the peer is loopback" no
   *  longer means "the caller is on this machine" — see {@link handleHealth}. */
  reachable: boolean
  /** What a native app may sign in with, public like the switches: `microsoft` exactly
   *  when this hub serves the app sign-in (hub-auth `app-sign-in.ts`; Entra hubs). The
   *  switches cannot tell — an older hub has SSO on but not the app routes. */
  appSignIn: { microsoft: boolean }
  /** Live count of connected computers. A GETTER, not a number — the value must
   *  reflect the gateway at request time, not a boot-time snapshot. */
  computersConnected: () => number
}

/**
 * True when the request arrived over loopback. `remoteAddress` may be an
 * IPv4-mapped IPv6 address (`::ffff:127.0.0.1`) when the server binds a dual-stack
 * socket, so strip that prefix before matching.
 *
 * A missing `remoteAddress` (destroyed socket) is treated as NON-loopback — the
 * gate fails closed.
 */
function isLoopbackRequest(req: IncomingMessage): boolean {
  // `socket` is always present on a real request; optional-chained so a
  // hand-built request object can never throw INSIDE the liveness endpoint.
  //
  // `isLoopbackPeer`, NOT `LOOPBACK_HOSTS`: this matches a SOCKET ADDRESS, and
  // the host-string set both accepts `'localhost'` (never a peer address) and
  // misses the rest of `127.0.0.0/8` — so a peer on e.g. `127.0.0.53` was being
  // classified off-box. See the two predicates' docstrings in `hub-addr.ts`.
  return isLoopbackPeer(req.socket?.remoteAddress)
}

/**
 * Headers a reverse proxy / tunnel / load balancer adds when it forwards a request.
 * A client dialling the hub directly on this machine (`slay`, the desktop app, a
 * health probe) sends none of them.
 */
const FORWARDING_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'forwarded',
  'x-real-ip',
  'via',
  'cf-connecting-ip',
  'true-client-ip',
  'x-azure-clientip'
] as const

function looksForwarded(req: IncomingMessage): boolean {
  return FORWARDING_HEADERS.some((h) => req.headers?.[h] !== undefined)
}

/**
 * May this caller see the host-describing fields (name, root, dbPath, pid,
 * supervised, computersConnected)?
 *
 *   - hub only this machine reaches: any loopback peer — nobody else can connect.
 *   - hub other machines reach (B13): a same-box reverse proxy hands us every remote
 *     request from 127.0.0.1, so the peer address alone proves nothing. A loopback
 *     peer counts only when the request carries none of the headers a proxy adds.
 *
 * That second test is a heuristic, not a boundary: a proxy that strips or never sets
 * forwarding headers (a raw TCP tunnel) still looks local. It stays this way because
 * `slay hub ls/stop/restart/users add` find a hub by what it says here
 * (`hub-discovery.ts` refuses a row without name/root/pid), so withholding the
 * fields from every caller of a reachable hub would make the deployment this change
 * exists for unmanageable. What leaks past a header-less proxy is a hub name, its
 * root and db paths, a pid and a computer count — no credential and nothing a
 * client can act on.
 */
function mayReadHostFields(state: HealthState, req: IncomingMessage): boolean {
  if (!isLoopbackRequest(req)) return false
  return !(state.reachable && looksForwarded(req))
}

/**
 * Handles `GET /health`. Returns true when the request was a health request
 * (so the caller stops processing it), false otherwise.
 *
 * TWO AUDIENCES, TWO PAYLOADS. `/health` is deliberately unauthenticated (it is
 * how a load balancer, the supervisor, and `slay hub ls` all check liveness), and
 * a hub may bind wider than loopback — so the response is split:
 *
 *   - PUBLIC (any caller): liveness + the running build + `authRequired` + the
 *     switches + `appSignIn`. Enough to answer "is this up, which code is it running,
 *     must I sign in first, and how". `authRequired` is deliberately public: a client has
 *     to learn it needs a token BEFORE it has one, the open `hub.describe` already
 *     advertises the same bit (and the switches) to any /trpc caller, and an
 *     unauthenticated request learns it anyway from the 401. The switches are
 *     booleans only — never the SSO tenant, client id or secret.
 *   - LOCAL ONLY ({@link mayReadHostFields}): everything that describes the host —
 *     the hub name, its SLAYZONE_ROOT, the db path, the pid, the supervised flag and
 *     the computer count. These exist for local discovery (`slay hub ls` probes
 *     127.0.0.1), so restricting them to this machine costs discovery nothing while
 *     keeping absolute filesystem paths and a signalable pid off the public surface.
 */
export function handleHealth(
  state: HealthState,
  req: IncomingMessage,
  res: ServerResponse
): boolean {
  if (req.url !== '/health' || req.method !== 'GET') return false
  if (!state.ready) {
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end('{"ok":false,"reason":"starting"}')
    return true
  }
  // Advertise the running build so a stale sidecar is detectable by comparing
  // against dist/sidecar-build.json (plans/sidecar-staleness.md, Phase 2).
  const build = getServerBuildInfo()
  const payload: Record<string, unknown> = {
    ok: true,
    port: state.port,
    uptimeMs: Date.now() - state.startedAt,
    commit: build.commit,
    builtAt: build.builtAt,
    buildId: build.buildId,
    authRequired: state.authRequired,
    switches: state.switches,
    appSignIn: state.appSignIn
  }
  if (mayReadHostFields(state, req)) {
    payload.name = state.name
    payload.root = state.root
    payload.dbPath = state.dbPath
    payload.pid = state.pid
    payload.supervised = state.supervised
    // Resolved per-request on purpose (see the field's note). A throwing getter
    // must not take /health down — liveness is the one thing this endpoint owes
    // its callers.
    try {
      payload.computersConnected = state.computersConnected()
    } catch {
      payload.computersConnected = null
    }
  }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
  return true
}
