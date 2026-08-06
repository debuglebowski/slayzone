import type { IncomingMessage, ServerResponse } from 'node:http'
import { LOOPBACK_HOSTS } from '@slayzone/platform/hub-addr'
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
  /** SLAYZONE_MODE — `local` or `remote`. */
  mode: string
  /** True when running under the Electron host supervisor. `slay hub stop`
   *  refuses these: the desktop app owns its own sidecar's lifecycle. */
  supervised: boolean
  /** Whether this hub gates its client API (`/trpc` + REST) on a bearer token.
   *  Derived from SLAYZONE_MODE — see `hubAuthRequired` in server.ts. */
  authRequired: boolean
  /** Live count of connected runners. A GETTER, not a number — the value must
   *  reflect the gateway at request time, not a boot-time snapshot. */
  runnersConnected: () => number
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
  const raw = req.socket?.remoteAddress
  if (!raw) return false
  return LOOPBACK_HOSTS.has(raw.replace(/^::ffff:/, ''))
}

/**
 * Handles `GET /health`. Returns true when the request was a health request
 * (so the caller stops processing it), false otherwise.
 *
 * TWO AUDIENCES, TWO PAYLOADS. `/health` is deliberately unauthenticated (it is
 * how a load balancer, the supervisor, and `slay hub ls` all check liveness), and
 * a hub may bind wider than loopback — so the response is split:
 *
 *   - PUBLIC (any caller): liveness + the running build + `authRequired`. Enough
 *     to answer "is this up, which code is it running, and must I sign in first".
 *     `authRequired` is deliberately public: a client has to learn it needs a
 *     token BEFORE it has one, the open `hub.describe` already advertises the
 *     same bit to any /trpc caller, and an unauthenticated request learns it
 *     anyway from the 401.
 *   - LOOPBACK ONLY: everything that describes the host — the hub name, its
 *     SLAYZONE_ROOT, the db path, the pid, and the runner count. These exist for
 *     local discovery (`slay hub ls` probes 127.0.0.1), so restricting them to
 *     loopback costs discovery nothing while keeping absolute filesystem paths
 *     and a signalable pid off the public surface. `dbPath` was previously served
 *     to every caller; it is now in this group.
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
    authRequired: state.authRequired
  }
  if (isLoopbackRequest(req)) {
    payload.name = state.name
    payload.root = state.root
    payload.dbPath = state.dbPath
    payload.pid = state.pid
    payload.mode = state.mode
    payload.supervised = state.supervised
    // Resolved per-request on purpose (see the field's note). A throwing getter
    // must not take /health down — liveness is the one thing this endpoint owes
    // its callers.
    try {
      payload.runnersConnected = state.runnersConnected()
    } catch {
      payload.runnersConnected = null
    }
  }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
  return true
}
