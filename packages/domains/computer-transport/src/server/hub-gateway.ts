/**
 * Hub-side computer gateway. Owns every computer WebSocket that dialed in, speaks
 * the duplex JSON-RPC computer protocol over each, and exposes an addressable
 * request/notify surface keyed by computerId.
 *
 * Authentication is fully injected (`verifyEnrollment` / `verifyApiKey`) so
 * this package never reaches into hub persistence — the hub app decides how
 * join tokens are validated and how credentials are minted/stored.
 *
 * Connection lifecycle:
 *  0. `admitUpgrade(peer)` — before the host completes the WebSocket upgrade: refuse
 *     it cheaply, with no per-socket state, when the flood limits say so (T-26,
 *     {@link ComputerFloodLimits}).
 *  1. `handleConnection(ws)` — socket accepted, unauthenticated. The first
 *     computer request must be `enroll` (join token) or `hello` (api key);
 *     anything else is rejected with `unauthorized`. Sockets that never
 *     authenticate are dropped after `authTimeoutMs`, and one that tries more
 *     than `attemptsPerSocket` times is closed.
 *  2. Authenticated — computer is registered (a reconnect supersedes any stale
 *     socket for the same computerId), heartbeat watchdog armed.
 *  3. Loss — missing heartbeats/traffic for `heartbeatTimeoutMs` terminates
 *     the socket and emits `computer-lost`; a clean close emits
 *     `computer-disconnected`.
 *
 * @module computer/server/hub-gateway
 */

import type { WebSocket } from 'ws'
import {
  addressBucket,
  createFixedWindowLimiter,
  createRateLimitAudit
} from '@slayzone/platform/rate-limit'
import {
  currentSecurityContext,
  runWithSecurityContext,
  securityEvent,
  type SecurityOutcome
} from '@slayzone/platform/security-log'
import { TypedEventEmitter } from '../shared/events'
import {
  type FsChangeParams,
  type EnrollParams,
  enrollParamsSchema,
  COMPUTER_PROTOCOL_VERSION,
  ComputerTransportErrorCodes,
  helloParamsSchema,
  heartbeatParamsSchema,
  type ProcDataParams,
  type ProcExitParams,
  type PtyDataParams,
  type PtyExitParams,
  type ComputerEventParams,
  ComputerNotificationMethods,
  computerNotificationSchemas,
  ComputerToHubMethods,
  type RequestActor
} from '../shared/frames'
import { DuplexRpc, JSON_RPC_METHOD_NOT_FOUND, type JsonRpcId, RpcError } from '../shared/rpc'
import { wsDataByteLength, wsDataToText } from '../shared/ws-data'
import { auditedHubCall } from './hub-audit'

export interface ComputerDescriptor {
  computerId: string
  name?: string
  platform?: string
  version?: string
  capabilities?: string[]
  protocolVersion?: number
  /** How this session authenticated. */
  authMode: 'enroll' | 'hello'
  /**
   * The computer PROCESS incarnation behind this connection (see `epochField` in
   * shared/frames). Compare across reconnects: unchanged ⇒ the same process
   * still holds its pty sessions and the hub may reattach; changed ⇒ a restart,
   * and everything the old incarnation held is provably gone.
   *
   * `undefined` from a computer too old to report one — which proves NEITHER, so
   * consumers must fall back to the conservative pre-epoch behavior rather than
   * treating absence as a match.
   */
  epoch?: string
  connectedAt: number
  lastSeenAt: number
}

export type ComputerGatewayEvents = {
  /** New computer enrolled (first contact — credentials were just minted). */
  'computer-enrolled': { computer: ComputerDescriptor }
  /** Computer session authenticated (fires for both enroll and hello). */
  'computer-connected': { computer: ComputerDescriptor }
  /** Authenticated session ended (socket closed or superseded). */
  'computer-disconnected': { computerId: string; reason: string }
  /** Heartbeat watchdog fired — socket was terminated. */
  'computer-lost': { computerId: string; reason: 'heartbeat-timeout' }
  'pty.data': PtyDataParams & { computerId: string }
  'pty.exit': PtyExitParams & { computerId: string }
  /** Child-process stdout/stderr chunk from a routed `proc.spawn` (arrival order,
   *  not sequenced). Demuxed by `createRoutingProcessBackend`. */
  'proc.data': ProcDataParams & { computerId: string }
  /** Routed child process exited. Demuxed by `createRoutingProcessBackend`. */
  'proc.exit': ProcExitParams & { computerId: string }
  event: ComputerEventParams & { computerId: string }
  /** A watched file changed on a computer. Demuxed by `watchId` in the routed
   *  workspace-fs adapters — see `createRemoteFsAdapters`. */
  'fs.change': FsChangeParams & { computerId: string }
  /** Malformed or unexpected frame (never fatal to the gateway). */
  'protocol-error': { computerId: string | null; detail: string; line?: string }
}

export interface HubComputerGatewayOptions {
  /**
   * Validate a join token and mint credentials for a new computer. Throw (or
   * reject) to refuse — an `RpcError` propagates its code, anything else maps
   * to `unauthorized`. Should be idempotent per (joinToken, name): the socket
   * can drop between minting and delivery, in which case the computer enrolls
   * again and any previously minted credential is never used.
   */
  verifyEnrollment: (params: EnrollParams) => Promise<{ computerId: string; apiKey: string }>
  /** Resolve an api key to a computer identity, or null to refuse. */
  /** `hostId` rides the HELLO frame: a computer that adopted a peer's id while
   *  offline reports it on reconnect, and that is the only moment the hub can
   *  learn it. Absent from an older peer, which stays ungrouped. */
  verifyApiKey: (
    apiKey: string,
    context?: { hostId?: string }
  ) => Promise<{
    computerId: string
    name?: string
    platform?: string
    version?: string
    capabilities?: string[]
  } | null>
  /** Drop authenticated computers silent for this long. `0` disables. Default 45s. */
  heartbeatTimeoutMs?: number
  /** Drop sockets that never authenticate. Default 10s. */
  authTimeoutMs?: number
  /** Default timeout for hub→computer requests. Default 30s. */
  requestTimeoutMs?: number
  /**
   * Caps on what a client that has not authenticated can hold or retry (T-26). Default
   * {@link DEFAULT_COMPUTER_FLOOD_LIMITS}; `false` = none, for a hub no other machine
   * can reach (the desktop app's, whose only computer is its own).
   */
  floodLimits?: ComputerFloodLimits | false
  log?: (message: string, meta?: Record<string, unknown>) => void
}

/**
 * Flood limits on `/computers` (T-26), all keyed on the client address (an IPv6
 * address as its /64). They touch only sockets that have NOT authenticated: an
 * authenticated computer holds no pending slot and is never counted, and a refused
 * upgrade is a transient failure to the computer, which retries with backoff
 * (`hub-dialer.ts`), so a burst over a cap delays a reconnect rather than losing one.
 */
export interface ComputerFloodLimits {
  /** Unauthenticated sockets one address may hold at once. */
  pendingPerAddress: number
  /** Unauthenticated sockets the hub holds at once, all addresses together. */
  pendingTotal: number
  /** `enroll`/`hello` requests one socket may send before it is closed. */
  attemptsPerSocket: number
  /** Sockets from one address that ended without authenticating, per window, after
   *  which that address's upgrades are refused until the window ends. */
  failedPerAddress: number
  failedWindowMs: number
}

/**
 * Sized for one hub's computers, several of which may share an address (an office
 * NAT, a cloud NAT gateway) and all reconnect at once after a hub restart:
 *   - 16 pending per address, 256 in total: a reconnect authenticates in one round
 *     trip, so a slot is held for milliseconds; past the cap the computer retries in
 *     100 ms, 200 ms, …
 *   - 4 attempts per socket: a computer needs at most 3 (`hello`, then `enroll` when
 *     the hub has forgotten its key, then `enroll` once more with a fresh join token).
 *   - 30 failed sockets per address a minute: a computer that authenticates fails
 *     none, one with a dead credential stops after one or two. With 4 attempts each,
 *     one address gets at most ~120 credential checks a minute.
 */
export const DEFAULT_COMPUTER_FLOOD_LIMITS: ComputerFloodLimits = {
  pendingPerAddress: 16,
  pendingTotal: 256,
  attemptsPerSocket: 4,
  failedPerAddress: 30,
  failedWindowMs: 60_000
}

/** {@link HubComputerGateway.admitUpgrade}'s answer. */
export type ComputerUpgradeAdmission =
  | { ok: true }
  | {
      ok: false
      /** 429: this address is over a limit; 503: the hub is (all addresses together). */
      status: 429 | 503
      retryAfterSec: number
      /** The limit that refused it (the audit line's `detail.limit`). */
      limit: string
    }

/** Where an accepted computer socket came from — for the audit log. */
export interface ComputerPeer {
  /** Client address of the upgrade request: the TCP peer, or the client a trusted front
   *  end forwarded (`clientAddress` in `@slayzone/platform/client-address`, T-22). */
  ip?: string | null
}

export interface HubComputerGateway {
  /**
   * Whether to complete a `/computers` upgrade from `peer` (T-26). Call it BEFORE the
   * upgrade, in the same tick as `handleConnection` would follow it: a refusal costs
   * no socket, no RPC state and no timer. Refusals are audited once per limit and
   * address a minute.
   */
  admitUpgrade(peer?: ComputerPeer): ComputerUpgradeAdmission
  /** Adopt an accepted WebSocket (e.g. from a `ws` server `connection` event). */
  handleConnection(ws: WebSocket, peer?: ComputerPeer): void
  /** Send a request to a connected computer. Rejects `unknownComputer` if absent. */
  request<T = unknown>(
    computerId: string,
    method: string,
    params?: unknown,
    timeoutMs?: number
  ): Promise<T>
  /** Fire-and-forget notification to a connected computer (no-op if absent). */
  notify(computerId: string, method: string, params?: unknown): void
  /**
   * Every computer with an authenticated, open connection. Says nothing about
   * liveness — a computer whose socket is open but which has gone silent still
   * appears here until the heartbeat watchdog reaps it (up to
   * `heartbeatTimeoutMs`). Use {@link listUsableComputers} to decide whether work
   * can actually be dispatched.
   */
  listComputers(): ComputerDescriptor[]
  /**
   * ── The single authority on "can this computer do work right now?" ───────────
   *
   * Authenticated + open + heard from within `heartbeatTimeoutMs`. This is the
   * ONLY question a dispatch decision should ask.
   *
   * It exists because three different signals were being used as proxies for it,
   * and all three lie in a different direction:
   *   - the `computers` DB row — means "was enrolled once". Survives everything,
   *     including a computer that never connected during this boot at all.
   *   - the raw `byComputerId` map (i.e. `listComputers`) — means "socket is open".
   *     Wiped whenever the hub process restarts, and includes a computer that has
   *     stopped responding but not yet been reaped.
   *   - a last-known-computer cache — means "was connected recently". Can name a
   *     computer that is now gone.
   *
   * Anything that must not dispatch into a void (see the no-in-process-fallback
   * work) resolves through here, not through those.
   */
  listUsableComputers(): ComputerDescriptor[]
  /** {@link listUsableComputers} for one computer. */
  isComputerUsable(computerId: string): boolean
  readonly events: TypedEventEmitter<ComputerGatewayEvents>
  /**
   * Drop one computer's connection now and reject its in-flight requests — for a
   * computer whose credential was just revoked (T-12: its owner was disabled), which
   * would otherwise keep working until it next reconnected. False when it is not
   * connected. It may dial back: whether its `hello` is accepted is `verifyApiKey`'s
   * decision, not this one's.
   */
  disconnect(computerId: string, reason: string): boolean
  /** Terminate every connection and reject all in-flight requests. */
  close(): void
}

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000
// Kept at 10 s under the flood limits (T-26): the caps, not the timeout, bound what idle
// sockets can hold (16 per address for at most 10 s, each a strike when it lapses), while
// a shorter one would start failing a slow computer's first frame — a laptop just woken,
// a high-latency link — and every lapse is a strike against its address.
const DEFAULT_AUTH_TIMEOUT_MS = 10_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/**
 * Largest frame a socket may send before enroll/hello succeeds. A real enroll or hello
 * is well under 4 KiB (a join token or api key, a name, a few capability tags).
 *
 * Why a cap: the socket is anyone's until then, ws accepts a 100 MiB frame by default,
 * and a frame is JSON-parsed then zod-validated. zod <= 4.6.5 allocates one issue per
 * failing array element (GHSA-mrhx-c7xc-m3w5), measured at ~180 bytes of heap per byte
 * of `capabilities: [0, 0, …]`, so a 100 MiB enroll is many GiB: an out-of-memory hub
 * with no credential. 64 KiB bounds that to ~12 MiB per frame. Authenticated computers
 * are not capped (pty output, file reads and command output ride their frames). Keep it
 * after the zod bump: an unauthenticated peer has no reason to send more.
 */
export const PRE_AUTH_FRAME_MAX_BYTES = 64 * 1024

/**
 * Wall-clock lateness above which a watchdog fire is attributed to THIS PROCESS
 * having been frozen rather than to the computer going silent.
 *
 * Ordinary event-loop lag is tens of milliseconds, seconds at the very worst
 * under load; a host sleep is seconds to hours. Biased deliberately low: a false
 * freeze-detection costs one extra heartbeat window of delay, a false reap costs
 * every agent session on the computer.
 *
 * Lateness rather than a monotonic clock: libuv's monotonic source ticks through
 * system sleep on some platforms and not others, so `performance.now()` would
 * make this correct on one OS and silently useless on another. `setTimeout`
 * cannot fire early anywhere.
 */
const SUSPEND_LATENESS_MS = 2_000

interface ComputerConnection {
  ws: WebSocket
  /** TCP peer address, for audit lines. */
  ip: string | null
  /** Flood-limit key of `ip` while this socket holds a pending slot, else null. */
  pendingBucket: string | null
  /** `enroll`/`hello` requests made before authenticating. */
  authAttempts: number
  rpc: DuplexRpc
  descriptor: ComputerDescriptor | null
  heartbeatTimer: ReturnType<typeof setTimeout> | null
  authTimer: ReturnType<typeof setTimeout> | null
  closed: boolean
}

export function createHubComputerGateway(options: HubComputerGatewayOptions): HubComputerGateway {
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS
  const authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const log =
    options.log ??
    (() => {
      // Logging is opt-in — a host that passes no sink discards gateway diagnostics.
    })

  const events = new TypedEventEmitter<ComputerGatewayEvents>((event, err) => {
    log('computer gateway listener threw', { event: String(event), error: String(err) })
  })
  const byComputerId = new Map<string, ComputerConnection>()
  const connections = new Set<ComputerConnection>()
  let closed = false

  // ── Flood limits (T-26) ─────────────────────────────────────────────────────
  const limits =
    options.floodLimits === false ? null : (options.floodLimits ?? DEFAULT_COMPUTER_FLOOD_LIMITS)
  const pendingByBucket = new Map<string, number>()
  let pendingTotal = 0
  const failedSockets = createFixedWindowLimiter()
  const auditRefusal = createRateLimitAudit()
  const failedRule = limits
    ? { max: limits.failedPerAddress, windowMs: limits.failedWindowMs }
    : null

  /** Over a limit? Read-only: nothing is counted here. */
  function overLimit(ip: string | null): ComputerUpgradeAdmission {
    if (!limits) return { ok: true }
    const bucket = addressBucket(ip)
    const failed = failedSockets.check(bucket, failedRule!)
    if (!failed.allowed) {
      return {
        ok: false,
        status: 429,
        retryAfterSec: failed.retryAfterSec,
        limit: 'computers.failed_per_address'
      }
    }
    if ((pendingByBucket.get(bucket) ?? 0) >= limits.pendingPerAddress) {
      return { ok: false, status: 429, retryAfterSec: 1, limit: 'computers.pending_per_address' }
    }
    if (pendingTotal >= limits.pendingTotal) {
      return { ok: false, status: 503, retryAfterSec: 1, limit: 'computers.pending_total' }
    }
    return { ok: true }
  }

  function auditLimit(ip: string | null, limit: string, retryAfterSec?: number): void {
    if (!limits) return
    const max =
      limit === 'computers.failed_per_address'
        ? limits.failedPerAddress
        : limit === 'computers.pending_per_address'
          ? limits.pendingPerAddress
          : limit === 'computers.pending_total'
            ? limits.pendingTotal
            : limits.attemptsPerSocket
    auditRefusal({
      limit,
      address: ip,
      route: 'WS /computers',
      max,
      ...(limit === 'computers.failed_per_address'
        ? { windowSec: Math.round(limits.failedWindowMs / 1000) }
        : {}),
      ...(retryAfterSec === undefined ? {} : { retryAfterSec })
    })
  }

  function admitUpgrade(peer?: ComputerPeer): ComputerUpgradeAdmission {
    if (closed) return { ok: false, status: 503, retryAfterSec: 1, limit: 'computers.closed' }
    const ip = peer?.ip ?? null
    const verdict = overLimit(ip)
    if (!verdict.ok) auditLimit(ip, verdict.limit, verdict.retryAfterSec)
    return verdict
  }

  /** Release `conn`'s pending slot (it authenticated, or it ended). Idempotent. */
  function releasePending(conn: ComputerConnection): void {
    const bucket = conn.pendingBucket
    if (bucket === null) return
    conn.pendingBucket = null
    pendingTotal -= 1
    const left = (pendingByBucket.get(bucket) ?? 1) - 1
    if (left > 0) pendingByBucket.set(bucket, left)
    else pendingByBucket.delete(bucket)
  }

  function protocolError(conn: ComputerConnection, detail: string, line?: string): void {
    events.emit('protocol-error', {
      computerId: conn.descriptor?.computerId ?? null,
      detail,
      ...(line === undefined ? {} : { line })
    })
  }

  /**
   * Audit line for an enroll or hello attempt (T-03). Never the join token or the
   * api key — a reason code and, on success, who enrolled. A computer is not a user,
   * so there is no request context to inherit: every field is explicit.
   */
  function auditAuth(
    conn: ComputerConnection,
    event: 'computer.enroll' | 'computer.hello',
    outcome: SecurityOutcome,
    computerId: string | null,
    detail: Record<string, unknown>
  ): void {
    securityEvent({
      event,
      outcome,
      actor: computerId,
      ip: conn.ip,
      targetKind: 'computer',
      targetId: computerId,
      route: 'WS /computers',
      detail
    })
  }

  /** Error code for an audit line: a JSON-RPC code, or the error's class. */
  const errorCode = (err: unknown): number | string =>
    err instanceof RpcError ? err.code : err instanceof Error ? err.name : 'error'

  /**
   * Lazy watchdog: instead of re-arming a timer per inbound frame (ruinous
   * under a pty.data flood), the timer fires on schedule and checks how stale
   * `lastSeenAt` actually is — re-arming itself for the remainder when the
   * computer has been heard from.
   *
   * It also refuses to judge a window this process did not witness — see the
   * freeze guard below.
   */
  function armHeartbeatWatchdog(
    conn: ComputerConnection,
    delayMs: number = heartbeatTimeoutMs
  ): void {
    if (heartbeatTimeoutMs <= 0 || conn.closed) return
    const armedAt = Date.now()
    conn.heartbeatTimer = setTimeout(() => {
      // ── Freeze guard ────────────────────────────────────────────────────────
      // `setTimeout` cannot fire EARLY, so a fire whose wall-clock lateness far
      // exceeds its own delay means this process was not running for most of the
      // window: host sleep (closing a laptop lid), VM suspend, a stopped
      // debugger. The silence about to be judged was never actually observed —
      // and judging it disposes every terminal session on a computer that is
      // still very much alive, each surfacing as a fabricated
      // "Process exited with code 1". Re-arm and look again with a window this
      // process was awake for.
      const latenessMs = Date.now() - armedAt - delayMs
      if (latenessMs > SUSPEND_LATENESS_MS) {
        log('watchdog fired after a process freeze — re-arming instead of reaping', {
          computerId: conn.descriptor?.computerId ?? null,
          latenessMs
        })
        armHeartbeatWatchdog(conn)
        return
      }
      const lastSeenAt = conn.descriptor?.lastSeenAt ?? 0
      const idleMs = Date.now() - lastSeenAt
      if (idleMs < heartbeatTimeoutMs) {
        armHeartbeatWatchdog(conn, heartbeatTimeoutMs - idleMs)
        return
      }
      const computerId = conn.descriptor?.computerId
      if (computerId) {
        events.emit('computer-lost', { computerId, reason: 'heartbeat-timeout' })
      }
      teardown(conn, 'heartbeat-timeout')
      conn.ws.terminate()
    }, delayMs)
    conn.heartbeatTimer.unref?.()
  }

  /**
   * Backs {@link HubComputerGateway.listUsableComputers}: authenticated, open, and
   * heard from within the heartbeat window.
   *
   * The staleness check is deliberately independent of the watchdog rather than
   * trusting it. The watchdog reaps on a timer, so between a computer going silent
   * and its timer firing there is a window (up to `heartbeatTimeoutMs`) where the
   * connection is still in `byComputerId` — dispatching into that window is exactly
   * the failure this predicate exists to prevent. Computing staleness on read
   * closes it without making the watchdog more aggressive (which would tear down
   * healthy computers on a slow link).
   *
   * `heartbeatTimeoutMs <= 0` disables the watchdog entirely (tests), so treat any
   * authenticated open connection as usable in that mode.
   */
  function isUsable(
    conn: ComputerConnection
  ): conn is ComputerConnection & { descriptor: ComputerDescriptor } {
    if (conn.closed || conn.descriptor === null) return false
    if (heartbeatTimeoutMs <= 0) return true
    return Date.now() - conn.descriptor.lastSeenAt < heartbeatTimeoutMs
  }

  /** Any valid inbound frame from an authenticated computer counts as liveness. */
  function markAlive(conn: ComputerConnection): void {
    if (!conn.descriptor) return
    conn.descriptor.lastSeenAt = Date.now()
  }

  function teardown(conn: ComputerConnection, reason: string): void {
    if (conn.closed) return
    conn.closed = true
    // A socket that held a pending slot and ends without authenticating is a strike
    // against its address — timed out, closed, or closed for too many attempts. Not
    // when the hub itself is shutting down.
    if (conn.pendingBucket !== null && conn.descriptor === null && reason !== 'gateway-closed') {
      failedSockets.hit(conn.pendingBucket, failedRule!)
    }
    releasePending(conn)
    if (conn.heartbeatTimer) clearTimeout(conn.heartbeatTimer)
    if (conn.authTimer) clearTimeout(conn.authTimer)
    conn.rpc.dispose(reason)
    connections.delete(conn)
    const computerId = conn.descriptor?.computerId
    if (computerId && byComputerId.get(computerId) === conn) {
      byComputerId.delete(computerId)
      events.emit('computer-disconnected', { computerId, reason })
    }
  }

  function register(conn: ComputerConnection, descriptor: ComputerDescriptor): void {
    const stale = byComputerId.get(descriptor.computerId)
    if (stale && stale !== conn) {
      teardown(stale, 'superseded-by-reconnect')
      stale.ws.terminate()
    }
    conn.descriptor = descriptor
    byComputerId.set(descriptor.computerId, conn)
    releasePending(conn)
    if (conn.authTimer) {
      clearTimeout(conn.authTimer)
      conn.authTimer = null
    }
    if (conn.heartbeatTimer) clearTimeout(conn.heartbeatTimer)
    armHeartbeatWatchdog(conn)
  }

  async function handleEnroll(
    conn: ComputerConnection,
    params: unknown,
    id: JsonRpcId
  ): Promise<void> {
    const parsed = enrollParamsSchema.safeParse(params)
    if (!parsed.success) {
      conn.rpc.respondError(
        id,
        ComputerTransportErrorCodes.unauthorized,
        'malformed enroll request'
      )
      protocolError(conn, `malformed enroll params: ${parsed.error.message}`)
      auditAuth(conn, 'computer.enroll', 'failure', null, { reason: 'malformed' })
      conn.ws.close(1008, 'malformed enroll')
      return
    }
    if (parsed.data.protocolVersion !== COMPUTER_PROTOCOL_VERSION) {
      conn.rpc.respondError(
        id,
        ComputerTransportErrorCodes.protocolMismatch,
        `hub speaks computer protocol v${COMPUTER_PROTOCOL_VERSION}, computer sent v${parsed.data.protocolVersion}`
      )
      auditAuth(conn, 'computer.enroll', 'failure', null, {
        reason: 'protocol_mismatch',
        protocolVersion: parsed.data.protocolVersion
      })
      conn.ws.close(1008, 'protocol mismatch')
      return
    }
    let minted: { computerId: string; apiKey: string }
    try {
      // In this socket's context, so the join-token redeem line it writes carries the
      // peer address.
      minted = await runWithSecurityContext(
        { actor: null, ip: conn.ip, route: 'WS /computers' },
        () => options.verifyEnrollment(parsed.data)
      )
    } catch (err) {
      const code = err instanceof RpcError ? err.code : ComputerTransportErrorCodes.unauthorized
      const message = err instanceof Error ? err.message : 'enrollment rejected'
      conn.rpc.respondError(id, code, message)
      auditAuth(conn, 'computer.enroll', 'failure', null, { reason: 'rejected', code })
      // Keep the socket open: the auth timeout reaps it if the computer has no
      // other way in, and a well-behaved computer disconnects on its own.
      return
    }
    if (conn.closed) return
    const descriptor: ComputerDescriptor = {
      computerId: minted.computerId,
      name: parsed.data.name,
      platform: parsed.data.platform,
      version: parsed.data.version,
      capabilities: parsed.data.capabilities,
      protocolVersion: parsed.data.protocolVersion,
      authMode: 'enroll',
      ...(parsed.data.epoch ? { epoch: parsed.data.epoch } : {}),
      connectedAt: Date.now(),
      lastSeenAt: Date.now()
    }
    register(conn, descriptor)
    conn.rpc.respond(id, {
      computerId: minted.computerId,
      apiKey: minted.apiKey,
      protocolVersion: COMPUTER_PROTOCOL_VERSION
    })
    events.emit('computer-enrolled', { computer: { ...descriptor } })
    events.emit('computer-connected', { computer: { ...descriptor } })
    auditAuth(conn, 'computer.enroll', 'success', minted.computerId, {
      name: descriptor.name,
      platform: descriptor.platform,
      version: descriptor.version
    })
    log('computer computer enrolled', { computerId: minted.computerId, name: descriptor.name })
  }

  async function handleHello(
    conn: ComputerConnection,
    params: unknown,
    id: JsonRpcId
  ): Promise<void> {
    const parsed = helloParamsSchema.safeParse(params)
    if (!parsed.success) {
      conn.rpc.respondError(id, ComputerTransportErrorCodes.unauthorized, 'malformed hello request')
      auditAuth(conn, 'computer.hello', 'failure', null, { reason: 'malformed' })
      conn.ws.close(1008, 'malformed hello')
      return
    }
    // v3 (T-27): a reconnect proves its protocol too. Before, only enroll did, so a
    // computer enrolled long ago kept reconnecting across breaking changes — and a
    // pre-v3 computer keeps no local request log, which is the point of v3.
    if (parsed.data.protocolVersion !== COMPUTER_PROTOCOL_VERSION) {
      const sent = parsed.data.protocolVersion ?? '<3 (none sent)'
      conn.rpc.respondError(
        id,
        ComputerTransportErrorCodes.protocolMismatch,
        `hub speaks computer protocol v${COMPUTER_PROTOCOL_VERSION}, computer sent v${sent} — upgrade this computer to the hub's release`
      )
      auditAuth(conn, 'computer.hello', 'failure', null, {
        reason: 'protocol_mismatch',
        protocolVersion: parsed.data.protocolVersion ?? null
      })
      // Valid shape, wrong version: not a flood strike (see computer_in_use below).
      releasePending(conn)
      conn.ws.close(1008, 'protocol mismatch')
      return
    }
    let identity: Awaited<ReturnType<HubComputerGatewayOptions['verifyApiKey']>>
    try {
      identity = await options.verifyApiKey(parsed.data.apiKey, { hostId: parsed.data.hostId })
    } catch (err) {
      conn.rpc.respondError(
        id,
        err instanceof RpcError ? err.code : ComputerTransportErrorCodes.unauthorized,
        err instanceof Error ? err.message : 'authentication failed'
      )
      auditAuth(conn, 'computer.hello', 'failure', null, {
        reason: 'error',
        code: errorCode(err)
      })
      return
    }
    if (conn.closed) return
    if (!identity) {
      // Keep the socket open so the computer can fall back to `enroll` on the
      // same connection; the auth timeout reaps sessions that never succeed.
      conn.rpc.respondError(id, ComputerTransportErrorCodes.unauthorized, 'unknown api key')
      // Unknown, revoked, or minted for another computer — `verifyApiKey` does not say.
      auditAuth(conn, 'computer.hello', 'failure', null, { reason: 'unknown_key' })
      return
    }
    // A different PROCESS claiming an id whose connection is still live is not a
    // reconnect — it is two computers sharing one credential store (e.g. an
    // orphaned app's computer and the next app's). Letting each supersede the
    // other disposed every session on every takeover. The incumbent keeps the
    // id; the newcomer's dialer retries and gets in once the incumbent is gone
    // (closed, or reaped by the heartbeat watchdog). Same epoch ⇒ the same
    // process over a fresh socket (half-open old one) ⇒ supersede as before. A
    // missing epoch on either side proves nothing ⇒ supersede as before.
    const incumbent = byComputerId.get(identity.computerId)
    const newEpoch = parsed.data.epoch
    if (
      incumbent &&
      incumbent !== conn &&
      isUsable(incumbent) &&
      incumbent.descriptor.epoch !== undefined &&
      newEpoch !== undefined &&
      incumbent.descriptor.epoch !== newEpoch
    ) {
      conn.rpc.respondError(
        id,
        ComputerTransportErrorCodes.computerInUse,
        'another live process is already connected as this computer'
      )
      auditAuth(conn, 'computer.hello', 'failure', identity.computerId, {
        reason: 'computer_in_use'
      })
      log('computer hello refused — another live process holds this computer id', {
        computerId: identity.computerId,
        incumbentEpoch: incumbent.descriptor.epoch,
        refusedEpoch: newEpoch
      })
      // Its credentials were valid — not a flood strike. Without this, a local
      // computer waiting out an incumbent would rate-limit its own address and
      // stay locked out after the incumbent left.
      releasePending(conn)
      conn.ws.close(1008, 'computer in use')
      return
    }
    const descriptor: ComputerDescriptor = {
      computerId: identity.computerId,
      name: identity.name,
      platform: identity.platform,
      version: identity.version,
      capabilities: identity.capabilities,
      authMode: 'hello',
      // From the hello FRAME, not from persistence: the epoch is a property of
      // the live process, and a stored one would survive the restart it exists
      // to detect.
      ...(parsed.data.epoch ? { epoch: parsed.data.epoch } : {}),
      connectedAt: Date.now(),
      lastSeenAt: Date.now()
    }
    register(conn, descriptor)
    conn.rpc.respond(id, {
      computerId: identity.computerId,
      protocolVersion: COMPUTER_PROTOCOL_VERSION
    })
    events.emit('computer-connected', { computer: { ...descriptor } })
    log('computer computer reconnected', { computerId: identity.computerId })
  }

  function handleComputerRequest(
    conn: ComputerConnection,
    method: string,
    params: unknown,
    id: JsonRpcId
  ): void {
    if (!conn.descriptor) {
      const isAuth = method === ComputerToHubMethods.enroll || method === ComputerToHubMethods.hello
      if (isAuth && limits && ++conn.authAttempts > limits.attemptsPerSocket) {
        conn.rpc.respondError(
          id,
          ComputerTransportErrorCodes.unauthorized,
          'too many authentication attempts on one connection'
        )
        auditLimit(conn.ip, 'computers.attempts_per_socket')
        conn.ws.close(1008, 'too many authentication attempts')
        return
      }
      if (method === ComputerToHubMethods.enroll) {
        void handleEnroll(conn, params, id)
      } else if (method === ComputerToHubMethods.hello) {
        void handleHello(conn, params, id)
      } else {
        conn.rpc.respondError(
          id,
          ComputerTransportErrorCodes.unauthorized,
          'authenticate with enroll or hello first'
        )
        protocolError(conn, `request '${method}' before authentication`)
      }
      return
    }
    markAlive(conn)
    switch (method) {
      case ComputerToHubMethods.heartbeat: {
        const parsed = heartbeatParamsSchema.safeParse(params ?? {})
        if (!parsed.success) {
          conn.rpc.respondError(id, JSON_RPC_METHOD_NOT_FOUND, 'malformed heartbeat')
          protocolError(conn, 'malformed heartbeat params')
          return
        }
        conn.rpc.respond(id, { ts: Date.now() })
        return
      }
      case ComputerToHubMethods.enroll:
      case ComputerToHubMethods.hello:
        conn.rpc.respondError(
          id,
          ComputerTransportErrorCodes.unauthorized,
          'session already authenticated'
        )
        return
      default:
        conn.rpc.respondError(id, JSON_RPC_METHOD_NOT_FOUND, `method not found: ${method}`)
    }
  }

  function handleComputerNotification(
    conn: ComputerConnection,
    method: string,
    params: unknown
  ): void {
    if (!conn.descriptor) {
      protocolError(conn, `notification '${method}' before authentication`)
      return
    }
    const schema = computerNotificationSchemas[method as keyof typeof computerNotificationSchemas]
    if (!schema) {
      protocolError(conn, `unknown notification method: ${method}`)
      return
    }
    const parsed = schema.safeParse(params)
    if (!parsed.success) {
      protocolError(conn, `malformed '${method}' notification: ${parsed.error.message}`)
      return
    }
    markAlive(conn)
    const computerId = conn.descriptor.computerId
    switch (method) {
      case ComputerNotificationMethods.ptyData:
        events.emit('pty.data', { computerId, ...(parsed.data as PtyDataParams) })
        return
      case ComputerNotificationMethods.ptyExit:
        events.emit('pty.exit', { computerId, ...(parsed.data as PtyExitParams) })
        return
      case ComputerNotificationMethods.procData:
        events.emit('proc.data', { computerId, ...(parsed.data as ProcDataParams) })
        return
      case ComputerNotificationMethods.procExit:
        events.emit('proc.exit', { computerId, ...(parsed.data as ProcExitParams) })
        return
      case ComputerNotificationMethods.event:
        events.emit('event', { computerId, ...(parsed.data as ComputerEventParams) })
        return
      case ComputerNotificationMethods.fsChange:
        events.emit('fs.change', { computerId, ...(parsed.data as FsChangeParams) })
        return
    }
  }

  function handleConnection(ws: WebSocket, peer?: ComputerPeer): void {
    if (closed) {
      ws.terminate()
      return
    }
    const ip = peer?.ip ?? null
    // Re-checked here for a host that adopts sockets without `admitUpgrade` first; in
    // the hub it was asked in the same tick, so this agrees with it.
    const admission = overLimit(ip)
    if (!admission.ok) {
      auditLimit(ip, admission.limit, admission.retryAfterSec)
      ws.terminate()
      return
    }
    const conn: ComputerConnection = {
      ws,
      ip,
      pendingBucket: null,
      authAttempts: 0,
      rpc: null as unknown as DuplexRpc,
      descriptor: null,
      heartbeatTimer: null,
      authTimer: null,
      closed: false
    }
    conn.rpc = new DuplexRpc({
      label: 'computer-hub',
      defaultRequestTimeoutMs: requestTimeoutMs,
      write: (line) => {
        ws.send(line)
      },
      onPeerRequest: (method, params, id) => handleComputerRequest(conn, method, params, id),
      onNotification: (method, params) => handleComputerNotification(conn, method, params),
      onParseError: (line, err) => protocolError(conn, `unparseable frame: ${String(err)}`, line)
    })
    connections.add(conn)
    if (limits) {
      const bucket = addressBucket(ip)
      conn.pendingBucket = bucket
      pendingByBucket.set(bucket, (pendingByBucket.get(bucket) ?? 0) + 1)
      pendingTotal += 1
    }

    if (authTimeoutMs > 0) {
      conn.authTimer = setTimeout(() => {
        if (!conn.descriptor) {
          protocolError(conn, 'authentication timeout')
          teardown(conn, 'auth-timeout')
          ws.terminate()
        }
      }, authTimeoutMs)
      conn.authTimer.unref?.()
    }

    ws.on('message', (data) => {
      if (!conn.descriptor && wsDataByteLength(data) > PRE_AUTH_FRAME_MAX_BYTES) {
        // Dropped unparsed: see PRE_AUTH_FRAME_MAX_BYTES. 1009 = message too big.
        protocolError(conn, `unauthenticated frame over ${PRE_AUTH_FRAME_MAX_BYTES} bytes`)
        ws.close(1009, 'frame too large before authentication')
        return
      }
      for (const line of wsDataToText(data).split('\n')) {
        if (line.trim().length > 0) conn.rpc.handleLine(line)
      }
    })
    ws.on('close', () => teardown(conn, 'socket-closed'))
    ws.on('error', (err) => {
      log('computer computer socket error', {
        computerId: conn.descriptor?.computerId,
        error: String(err)
      })
    })
  }

  function getConnection(computerId: string): ComputerConnection | null {
    return byComputerId.get(computerId) ?? null
  }

  return {
    events,
    admitUpgrade,
    handleConnection,
    request<T = unknown>(
      computerId: string,
      method: string,
      params?: unknown,
      timeoutMs?: number
    ): Promise<T> {
      // The privileged ones are audited here, the single door (see hub-audit.ts). Actor,
      // ip and route come from the caller's request context, captured by the promise
      // chain this call starts.
      const audited = auditedHubCall(method, params)
      const audit = (outcome: SecurityOutcome, err?: unknown): void => {
        if (!audited) return
        securityEvent({
          event: audited.event,
          // The computer's own policy said no (T-27): a refusal, not a malfunction.
          outcome:
            outcome === 'failure' &&
            err instanceof RpcError &&
            err.code === ComputerTransportErrorCodes.refusedByComputer
              ? 'denied'
              : outcome,
          targetKind: 'computer',
          targetId: computerId,
          detail: err === undefined ? audited.detail : { ...audited.detail, code: errorCode(err) }
        })
      }
      const conn = getConnection(computerId)
      if (!conn) {
        const err = new RpcError(
          ComputerTransportErrorCodes.unknownComputer,
          `computer '${computerId}' is not connected`
        )
        audit('failure', err)
        return Promise.reject(err)
      }
      // Who asked, for the computer's local request log (T-27). Same context the
      // audit line above reads; none = the hub acting on its own behalf.
      const ctx = currentSecurityContext()
      const actor: RequestActor = {
        userId: ctx?.actor ? ctx.actor.slice(0, 200) : null,
        route: ctx?.route ? ctx.route.slice(0, 200) : null
      }
      const sent = conn.rpc.request<T>(method, params, timeoutMs, actor)
      if (!audited) {
        // An unaudited method (a read, a probe) still leaves a line when the computer
        // REFUSES it by its own policy (T-27) — a jail refusal is worth seeing.
        return sent.catch((err: unknown) => {
          if (
            err instanceof RpcError &&
            err.code === ComputerTransportErrorCodes.refusedByComputer
          ) {
            securityEvent({
              event: 'computer.refused',
              outcome: 'denied',
              targetKind: 'computer',
              targetId: computerId,
              detail: { method, code: err.code }
            })
          }
          throw err
        })
      }
      return sent.then(
        (result) => {
          audit('success')
          return result
        },
        (err: unknown) => {
          audit('failure', err)
          throw err
        }
      )
    },
    notify(computerId: string, method: string, params?: unknown): void {
      getConnection(computerId)?.rpc.notify(method, params)
    },
    listComputers(): ComputerDescriptor[] {
      return [...byComputerId.values()]
        .filter(
          (conn): conn is ComputerConnection & { descriptor: ComputerDescriptor } =>
            conn.descriptor !== null
        )
        .map((conn) => ({ ...conn.descriptor }))
    },
    listUsableComputers(): ComputerDescriptor[] {
      return [...byComputerId.values()].filter(isUsable).map((conn) => ({ ...conn.descriptor }))
    },
    isComputerUsable(computerId: string): boolean {
      const conn = byComputerId.get(computerId)
      return conn !== undefined && isUsable(conn)
    },
    disconnect(computerId: string, reason: string): boolean {
      const conn = byComputerId.get(computerId)
      if (!conn) return false
      teardown(conn, reason)
      // 1008 = policy violation. A close reason is capped at 123 bytes.
      conn.ws.close(1008, reason.slice(0, 120))
      return true
    },
    close(): void {
      closed = true
      for (const conn of [...connections]) {
        teardown(conn, 'gateway-closed')
        conn.ws.terminate()
      }
      events.removeAllListeners()
    }
  }
}
