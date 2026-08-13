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
 *  1. `handleConnection(ws)` — socket accepted, unauthenticated. The first
 *     computer request must be `enroll` (join token) or `hello` (api key);
 *     anything else is rejected with `unauthorized`. Sockets that never
 *     authenticate are dropped after `authTimeoutMs`.
 *  2. Authenticated — computer is registered (a reconnect supersedes any stale
 *     socket for the same computerId), heartbeat watchdog armed.
 *  3. Loss — missing heartbeats/traffic for `heartbeatTimeoutMs` terminates
 *     the socket and emits `computer-lost`; a clean close emits
 *     `computer-disconnected`.
 *
 * @module computer/server/hub-gateway
 */

import type { WebSocket } from 'ws'
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
  ComputerToHubMethods
} from '../shared/frames'
import { DuplexRpc, JSON_RPC_METHOD_NOT_FOUND, type JsonRpcId, RpcError } from '../shared/rpc'
import { wsDataToText } from '../shared/ws-data'

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
  log?: (message: string, meta?: Record<string, unknown>) => void
}

export interface HubComputerGateway {
  /** Adopt an accepted WebSocket (e.g. from a `ws` server `connection` event). */
  handleConnection(ws: WebSocket): void
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
  /** Terminate every connection and reject all in-flight requests. */
  close(): void
}

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000
const DEFAULT_AUTH_TIMEOUT_MS = 10_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

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

  function protocolError(conn: ComputerConnection, detail: string, line?: string): void {
    events.emit('protocol-error', {
      computerId: conn.descriptor?.computerId ?? null,
      detail,
      ...(line === undefined ? {} : { line })
    })
  }

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
      conn.ws.close(1008, 'malformed enroll')
      return
    }
    if (parsed.data.protocolVersion !== COMPUTER_PROTOCOL_VERSION) {
      conn.rpc.respondError(
        id,
        ComputerTransportErrorCodes.protocolMismatch,
        `hub speaks computer protocol v${COMPUTER_PROTOCOL_VERSION}, computer sent v${parsed.data.protocolVersion}`
      )
      conn.ws.close(1008, 'protocol mismatch')
      return
    }
    let minted: { computerId: string; apiKey: string }
    try {
      minted = await options.verifyEnrollment(parsed.data)
    } catch (err) {
      const code = err instanceof RpcError ? err.code : ComputerTransportErrorCodes.unauthorized
      const message = err instanceof Error ? err.message : 'enrollment rejected'
      conn.rpc.respondError(id, code, message)
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
    conn.rpc.respond(id, { computerId: minted.computerId, apiKey: minted.apiKey })
    events.emit('computer-enrolled', { computer: { ...descriptor } })
    events.emit('computer-connected', { computer: { ...descriptor } })
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
      conn.ws.close(1008, 'malformed hello')
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
      return
    }
    if (conn.closed) return
    if (!identity) {
      // Keep the socket open so the computer can fall back to `enroll` on the
      // same connection; the auth timeout reaps sessions that never succeed.
      conn.rpc.respondError(id, ComputerTransportErrorCodes.unauthorized, 'unknown api key')
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
    conn.rpc.respond(id, { computerId: identity.computerId })
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

  function handleConnection(ws: WebSocket): void {
    if (closed) {
      ws.terminate()
      return
    }
    const conn: ComputerConnection = {
      ws,
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
    handleConnection,
    request<T = unknown>(
      computerId: string,
      method: string,
      params?: unknown,
      timeoutMs?: number
    ): Promise<T> {
      const conn = getConnection(computerId)
      if (!conn) {
        return Promise.reject(
          new RpcError(
            ComputerTransportErrorCodes.unknownComputer,
            `computer '${computerId}' is not connected`
          )
        )
      }
      return conn.rpc.request<T>(method, params, timeoutMs)
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
