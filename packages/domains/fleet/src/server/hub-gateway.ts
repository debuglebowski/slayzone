/**
 * Hub-side fleet gateway. Owns every runner WebSocket that dialed in, speaks
 * the duplex JSON-RPC fleet protocol over each, and exposes an addressable
 * request/notify surface keyed by runnerId.
 *
 * Authentication is fully injected (`verifyEnrollment` / `verifyApiKey`) so
 * this package never reaches into hub persistence — the hub app decides how
 * join tokens are validated and how credentials are minted/stored.
 *
 * Connection lifecycle:
 *  1. `handleConnection(ws)` — socket accepted, unauthenticated. The first
 *     runner request must be `enroll` (join token) or `hello` (api key);
 *     anything else is rejected with `unauthorized`. Sockets that never
 *     authenticate are dropped after `authTimeoutMs`.
 *  2. Authenticated — runner is registered (a reconnect supersedes any stale
 *     socket for the same runnerId), heartbeat watchdog armed.
 *  3. Loss — missing heartbeats/traffic for `heartbeatTimeoutMs` terminates
 *     the socket and emits `runner-lost`; a clean close emits
 *     `runner-disconnected`.
 *
 * @module fleet/server/hub-gateway
 */

import type { WebSocket } from 'ws'
import { TypedEventEmitter } from '../shared/events'
import {
  type CheckoutStatusParams,
  type EnrollParams,
  enrollParamsSchema,
  FLEET_PROTOCOL_VERSION,
  FleetErrorCodes,
  helloParamsSchema,
  heartbeatParamsSchema,
  type PtyDataParams,
  type PtyExitParams,
  type RunnerEventParams,
  RunnerNotificationMethods,
  runnerNotificationSchemas,
  RunnerToHubMethods
} from '../shared/frames'
import { DuplexRpc, JSON_RPC_METHOD_NOT_FOUND, type JsonRpcId, RpcError } from '../shared/rpc'
import { wsDataToText } from '../shared/ws-data'

export interface RunnerDescriptor {
  runnerId: string
  name?: string
  platform?: string
  version?: string
  capabilities?: string[]
  protocolVersion?: number
  /** How this session authenticated. */
  authMode: 'enroll' | 'hello'
  connectedAt: number
  lastSeenAt: number
}

export type FleetGatewayEvents = {
  /** New runner enrolled (first contact — credentials were just minted). */
  'runner-enrolled': { runner: RunnerDescriptor }
  /** Runner session authenticated (fires for both enroll and hello). */
  'runner-connected': { runner: RunnerDescriptor }
  /** Authenticated session ended (socket closed or superseded). */
  'runner-disconnected': { runnerId: string; reason: string }
  /** Heartbeat watchdog fired — socket was terminated. */
  'runner-lost': { runnerId: string; reason: 'heartbeat-timeout' }
  'pty.data': PtyDataParams & { runnerId: string }
  'pty.exit': PtyExitParams & { runnerId: string }
  event: RunnerEventParams & { runnerId: string }
  'checkout.status': CheckoutStatusParams & { runnerId: string }
  /** Malformed or unexpected frame (never fatal to the gateway). */
  'protocol-error': { runnerId: string | null; detail: string; line?: string }
}


export interface HubFleetGatewayOptions {
  /**
   * Validate a join token and mint credentials for a new runner. Throw (or
   * reject) to refuse — an `RpcError` propagates its code, anything else maps
   * to `unauthorized`. Should be idempotent per (joinToken, name): the socket
   * can drop between minting and delivery, in which case the runner enrolls
   * again and any previously minted credential is never used.
   */
  verifyEnrollment: (params: EnrollParams) => Promise<{ runnerId: string; apiKey: string }>
  /** Resolve an api key to a runner identity, or null to refuse. */
  verifyApiKey: (
    apiKey: string
  ) => Promise<{ runnerId: string; name?: string; platform?: string; version?: string; capabilities?: string[] } | null>
  /** Drop authenticated runners silent for this long. `0` disables. Default 45s. */
  heartbeatTimeoutMs?: number
  /** Drop sockets that never authenticate. Default 10s. */
  authTimeoutMs?: number
  /** Default timeout for hub→runner requests. Default 30s. */
  requestTimeoutMs?: number
  log?: (message: string, meta?: Record<string, unknown>) => void
}

export interface HubFleetGateway {
  /** Adopt an accepted WebSocket (e.g. from a `ws` server `connection` event). */
  handleConnection(ws: WebSocket): void
  /** Send a request to a connected runner. Rejects `unknownRunner` if absent. */
  request<T = unknown>(runnerId: string, method: string, params?: unknown, timeoutMs?: number): Promise<T>
  /** Fire-and-forget notification to a connected runner (no-op if absent). */
  notify(runnerId: string, method: string, params?: unknown): void
  listRunners(): RunnerDescriptor[]
  readonly events: TypedEventEmitter<FleetGatewayEvents>
  /** Terminate every connection and reject all in-flight requests. */
  close(): void
}

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000
const DEFAULT_AUTH_TIMEOUT_MS = 10_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

interface RunnerConnection {
  ws: WebSocket
  rpc: DuplexRpc
  descriptor: RunnerDescriptor | null
  heartbeatTimer: ReturnType<typeof setTimeout> | null
  authTimer: ReturnType<typeof setTimeout> | null
  closed: boolean
}

export function createHubFleetGateway(options: HubFleetGatewayOptions): HubFleetGateway {
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS
  const authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const log = options.log ?? (() => {})

  const events = new TypedEventEmitter<FleetGatewayEvents>((event, err) => {
    log('fleet gateway listener threw', { event: String(event), error: String(err) })
  })
  const byRunnerId = new Map<string, RunnerConnection>()
  const connections = new Set<RunnerConnection>()
  let closed = false

  function protocolError(conn: RunnerConnection, detail: string, line?: string): void {
    events.emit('protocol-error', {
      runnerId: conn.descriptor?.runnerId ?? null,
      detail,
      ...(line === undefined ? {} : { line })
    })
  }

  /**
   * Lazy watchdog: instead of re-arming a timer per inbound frame (ruinous
   * under a pty.data flood), the timer fires on schedule and checks how stale
   * `lastSeenAt` actually is — re-arming itself for the remainder when the
   * runner has been heard from.
   */
  function armHeartbeatWatchdog(conn: RunnerConnection, delayMs: number = heartbeatTimeoutMs): void {
    if (heartbeatTimeoutMs <= 0 || conn.closed) return
    conn.heartbeatTimer = setTimeout(() => {
      const lastSeenAt = conn.descriptor?.lastSeenAt ?? 0
      const idleMs = Date.now() - lastSeenAt
      if (idleMs < heartbeatTimeoutMs) {
        armHeartbeatWatchdog(conn, heartbeatTimeoutMs - idleMs)
        return
      }
      const runnerId = conn.descriptor?.runnerId
      if (runnerId) {
        events.emit('runner-lost', { runnerId, reason: 'heartbeat-timeout' })
      }
      teardown(conn, 'heartbeat-timeout')
      conn.ws.terminate()
    }, delayMs)
    conn.heartbeatTimer.unref?.()
  }

  /** Any valid inbound frame from an authenticated runner counts as liveness. */
  function markAlive(conn: RunnerConnection): void {
    if (!conn.descriptor) return
    conn.descriptor.lastSeenAt = Date.now()
  }

  function teardown(conn: RunnerConnection, reason: string): void {
    if (conn.closed) return
    conn.closed = true
    if (conn.heartbeatTimer) clearTimeout(conn.heartbeatTimer)
    if (conn.authTimer) clearTimeout(conn.authTimer)
    conn.rpc.dispose(reason)
    connections.delete(conn)
    const runnerId = conn.descriptor?.runnerId
    if (runnerId && byRunnerId.get(runnerId) === conn) {
      byRunnerId.delete(runnerId)
      events.emit('runner-disconnected', { runnerId, reason })
    }
  }

  function register(conn: RunnerConnection, descriptor: RunnerDescriptor): void {
    const stale = byRunnerId.get(descriptor.runnerId)
    if (stale && stale !== conn) {
      teardown(stale, 'superseded-by-reconnect')
      stale.ws.terminate()
    }
    conn.descriptor = descriptor
    byRunnerId.set(descriptor.runnerId, conn)
    if (conn.authTimer) {
      clearTimeout(conn.authTimer)
      conn.authTimer = null
    }
    if (conn.heartbeatTimer) clearTimeout(conn.heartbeatTimer)
    armHeartbeatWatchdog(conn)
  }

  async function handleEnroll(conn: RunnerConnection, params: unknown, id: JsonRpcId): Promise<void> {
    const parsed = enrollParamsSchema.safeParse(params)
    if (!parsed.success) {
      conn.rpc.respondError(id, FleetErrorCodes.unauthorized, 'malformed enroll request')
      protocolError(conn, `malformed enroll params: ${parsed.error.message}`)
      conn.ws.close(1008, 'malformed enroll')
      return
    }
    if (parsed.data.protocolVersion !== FLEET_PROTOCOL_VERSION) {
      conn.rpc.respondError(
        id,
        FleetErrorCodes.protocolMismatch,
        `hub speaks fleet protocol v${FLEET_PROTOCOL_VERSION}, runner sent v${parsed.data.protocolVersion}`
      )
      conn.ws.close(1008, 'protocol mismatch')
      return
    }
    let minted: { runnerId: string; apiKey: string }
    try {
      minted = await options.verifyEnrollment(parsed.data)
    } catch (err) {
      const code = err instanceof RpcError ? err.code : FleetErrorCodes.unauthorized
      const message = err instanceof Error ? err.message : 'enrollment rejected'
      conn.rpc.respondError(id, code, message)
      // Keep the socket open: the auth timeout reaps it if the runner has no
      // other way in, and a well-behaved runner disconnects on its own.
      return
    }
    if (conn.closed) return
    const descriptor: RunnerDescriptor = {
      runnerId: minted.runnerId,
      name: parsed.data.name,
      platform: parsed.data.platform,
      version: parsed.data.version,
      capabilities: parsed.data.capabilities,
      protocolVersion: parsed.data.protocolVersion,
      authMode: 'enroll',
      connectedAt: Date.now(),
      lastSeenAt: Date.now()
    }
    register(conn, descriptor)
    conn.rpc.respond(id, { runnerId: minted.runnerId, apiKey: minted.apiKey })
    events.emit('runner-enrolled', { runner: { ...descriptor } })
    events.emit('runner-connected', { runner: { ...descriptor } })
    log('fleet runner enrolled', { runnerId: minted.runnerId, name: descriptor.name })
  }

  async function handleHello(conn: RunnerConnection, params: unknown, id: JsonRpcId): Promise<void> {
    const parsed = helloParamsSchema.safeParse(params)
    if (!parsed.success) {
      conn.rpc.respondError(id, FleetErrorCodes.unauthorized, 'malformed hello request')
      conn.ws.close(1008, 'malformed hello')
      return
    }
    let identity: Awaited<ReturnType<HubFleetGatewayOptions['verifyApiKey']>>
    try {
      identity = await options.verifyApiKey(parsed.data.apiKey)
    } catch (err) {
      conn.rpc.respondError(
        id,
        err instanceof RpcError ? err.code : FleetErrorCodes.unauthorized,
        err instanceof Error ? err.message : 'authentication failed'
      )
      return
    }
    if (conn.closed) return
    if (!identity) {
      // Keep the socket open so the runner can fall back to `enroll` on the
      // same connection; the auth timeout reaps sessions that never succeed.
      conn.rpc.respondError(id, FleetErrorCodes.unauthorized, 'unknown api key')
      return
    }
    const descriptor: RunnerDescriptor = {
      runnerId: identity.runnerId,
      name: identity.name,
      platform: identity.platform,
      version: identity.version,
      capabilities: identity.capabilities,
      authMode: 'hello',
      connectedAt: Date.now(),
      lastSeenAt: Date.now()
    }
    register(conn, descriptor)
    conn.rpc.respond(id, { runnerId: identity.runnerId })
    events.emit('runner-connected', { runner: { ...descriptor } })
    log('fleet runner reconnected', { runnerId: identity.runnerId })
  }

  function handleRunnerRequest(conn: RunnerConnection, method: string, params: unknown, id: JsonRpcId): void {
    if (!conn.descriptor) {
      if (method === RunnerToHubMethods.enroll) {
        void handleEnroll(conn, params, id)
      } else if (method === RunnerToHubMethods.hello) {
        void handleHello(conn, params, id)
      } else {
        conn.rpc.respondError(id, FleetErrorCodes.unauthorized, 'authenticate with enroll or hello first')
        protocolError(conn, `request '${method}' before authentication`)
      }
      return
    }
    markAlive(conn)
    switch (method) {
      case RunnerToHubMethods.heartbeat: {
        const parsed = heartbeatParamsSchema.safeParse(params ?? {})
        if (!parsed.success) {
          conn.rpc.respondError(id, JSON_RPC_METHOD_NOT_FOUND, 'malformed heartbeat')
          protocolError(conn, 'malformed heartbeat params')
          return
        }
        conn.rpc.respond(id, { ts: Date.now() })
        return
      }
      case RunnerToHubMethods.enroll:
      case RunnerToHubMethods.hello:
        conn.rpc.respondError(id, FleetErrorCodes.unauthorized, 'session already authenticated')
        return
      default:
        conn.rpc.respondError(id, JSON_RPC_METHOD_NOT_FOUND, `method not found: ${method}`)
    }
  }

  function handleRunnerNotification(conn: RunnerConnection, method: string, params: unknown): void {
    if (!conn.descriptor) {
      protocolError(conn, `notification '${method}' before authentication`)
      return
    }
    const schema = runnerNotificationSchemas[method as keyof typeof runnerNotificationSchemas]
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
    const runnerId = conn.descriptor.runnerId
    switch (method) {
      case RunnerNotificationMethods.ptyData:
        events.emit('pty.data', { runnerId, ...(parsed.data as PtyDataParams) })
        return
      case RunnerNotificationMethods.ptyExit:
        events.emit('pty.exit', { runnerId, ...(parsed.data as PtyExitParams) })
        return
      case RunnerNotificationMethods.event:
        events.emit('event', { runnerId, ...(parsed.data as RunnerEventParams) })
        return
      case RunnerNotificationMethods.checkoutStatus:
        events.emit('checkout.status', { runnerId, ...(parsed.data as CheckoutStatusParams) })
        return
    }
  }

  function handleConnection(ws: WebSocket): void {
    if (closed) {
      ws.terminate()
      return
    }
    const conn: RunnerConnection = {
      ws,
      rpc: null as unknown as DuplexRpc,
      descriptor: null,
      heartbeatTimer: null,
      authTimer: null,
      closed: false
    }
    conn.rpc = new DuplexRpc({
      label: 'fleet-hub',
      defaultRequestTimeoutMs: requestTimeoutMs,
      write: (line) => {
        ws.send(line)
      },
      onPeerRequest: (method, params, id) => handleRunnerRequest(conn, method, params, id),
      onNotification: (method, params) => handleRunnerNotification(conn, method, params),
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
      log('fleet runner socket error', { runnerId: conn.descriptor?.runnerId, error: String(err) })
    })
  }

  function getConnection(runnerId: string): RunnerConnection | null {
    return byRunnerId.get(runnerId) ?? null
  }

  return {
    events,
    handleConnection,
    request<T = unknown>(runnerId: string, method: string, params?: unknown, timeoutMs?: number): Promise<T> {
      const conn = getConnection(runnerId)
      if (!conn) {
        return Promise.reject(
          new RpcError(FleetErrorCodes.unknownRunner, `runner '${runnerId}' is not connected`)
        )
      }
      return conn.rpc.request<T>(method, params, timeoutMs)
    },
    notify(runnerId: string, method: string, params?: unknown): void {
      getConnection(runnerId)?.rpc.notify(method, params)
    },
    listRunners(): RunnerDescriptor[] {
      return [...byRunnerId.values()]
        .filter((conn): conn is RunnerConnection & { descriptor: RunnerDescriptor } => conn.descriptor !== null)
        .map((conn) => ({ ...conn.descriptor }))
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
