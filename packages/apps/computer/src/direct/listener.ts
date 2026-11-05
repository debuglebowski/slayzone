/**
 * The computer's direct-link listener (docs/direct-link.md): clients reach terminal
 * and chat data here without the hub in the path.
 *
 * - **Plain HTTP + WebSocket, never TLS.** It binds `directListenAddress` (default
 *   `127.0.0.1:0`). A computer other machines reach sits behind a front end that
 *   terminates TLS, and advertises that front end's authority as
 *   `directPublicAddress`.
 * - **`GET /direct/v1/health`** is a plain-HTTP reachability probe. Clients call it
 *   before opening any WebSocket, because Chromium delays all of a renderer's
 *   sockets after failed WebSocket connects.
 * - **`/direct/v1`** serves the tRPC direct router (`@slayzone/transport/direct`).
 *   - A socket authenticates with a capability in its tRPC connection params, never
 *     in a URL. A socket with none, or with one this computer does not hold, is
 *     closed with 4401.
 *   - A socket stays open while it holds at least one live grant. When its last
 *     grant expires or is revoked or reset, it is closed with 4401, and the client
 *     goes back to the hub.
 * - **Flood limits** are counted per client address (an IPv6 address counts as its
 *   /64):
 *   - upgrades per minute;
 *   - open sockets;
 *   - failed authentications per minute (past it, upgrades are refused);
 *   - health probes per minute;
 *   - messages per socket;
 *   - message size;
 *   - grants per socket.
 *
 *   Every refusal is audited at most once per limit and address per minute. Behind
 *   a front end every client shares the front end's address, so the front end
 *   applies its own limits.
 * - **Tokens are never logged.** Neither the log nor the audit lines carry a token
 *   or its hash.
 *
 * @module computer/direct/listener
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { TRPCError } from '@trpc/server'
import { getWSConnectionHandler } from '@trpc/server/adapters/ws'
import { isLoopbackAuthority } from '@slayzone/platform/hub-addr'
import {
  addressBucket,
  createFixedWindowLimiter,
  type RateLimitRefusal,
  type RateRule
} from '@slayzone/platform/rate-limit'
import {
  createDirectRouter,
  DIRECT_ROUTER_PROTOCOL,
  type DirectContext,
  type DirectGrantView,
  type DirectRouterServices,
  type DirectSocket,
  type DirectTarget
} from '@slayzone/transport/direct'
import { WebSocketServer, type WebSocket } from 'ws'
import type { RtcServerSocket } from './rtc-socket'

/** A WebSocket, or a WebRTC data channel made to look like one (rtc-socket.ts). */
type ServedSocket = WebSocket | RtcServerSocket
import type { DirectGrantStore, GrantRecord } from './grants'

export const DIRECT_PATH = '/direct/v1'
export const DIRECT_HEALTH_PATH = '/direct/v1/health'

/** Close code for "no live capability": the client re-issues through the hub. */
export const DIRECT_CLOSE_UNAUTHORIZED = 4401

export interface DirectListenerLimits {
  upgradesPerMinute: number
  socketsPerAddress: number
  failedAuthsPerMinute: number
  healthPerMinute: number
  messagesPerSocketPer10s: number
  maxMessageBytes: number
  grantsPerSocket: number
  /** A socket that has not authenticated by then is closed. */
  authDeadlineMs: number
}

export const DEFAULT_DIRECT_LIMITS: DirectListenerLimits = {
  upgradesPerMinute: 120,
  socketsPerAddress: 64,
  failedAuthsPerMinute: 20,
  healthPerMinute: 240,
  // Keystrokes are one message each; a paste is one message. Generous for a person,
  // bounded for a loop.
  messagesPerSocketPer10s: 2_000,
  maxMessageBytes: 1024 * 1024,
  grantsPerSocket: 256,
  authDeadlineMs: 10_000
}

export interface DirectListenerOptions {
  grants: DirectGrantStore
  /** `host:port`, authority only. */
  listenAddress: string
  /** Operator-set authority clients dial (opt-in). */
  publicAddress?: string
  limits?: Partial<DirectListenerLimits>
  log: (message: string, detail?: Record<string, unknown>) => void
  /** One line per refusal (already deduplicated per limit, address and minute). */
  audit?: (refusal: RateLimitRefusal) => void
  /** What each hub link serves directly (looked up per grant). */
  services: DirectRouterServices
}

export interface DirectListener {
  /** What the socket actually bound, e.g. `127.0.0.1:53111`. */
  readonly boundAddress: string
  /** What hubs are told to offer clients; null = nothing dialable. */
  readonly advertisedAddress: string | null
  /**
   * Serve a WebRTC data channel exactly like an upgraded WebSocket: the same
   * capability auth, grants, flood limits and per-address caps. `ip` is the
   * client's address as the hub saw it while brokering. False (and the channel is
   * closed) when a per-address cap refuses it.
   */
  serveChannel(socket: RtcServerSocket, meta: { ip: string | null }): boolean
  close(): Promise<void>
}

/**
 * The authority to advertise: the operator's public address, else the bound one
 * when it is loopback (a same-machine client can dial it), else nothing — a
 * wildcard or LAN bind has no name a client can be given without the operator.
 */
export function advertisedDirectAddress(
  bound: string | null,
  publicAddress: string | undefined
): string | null {
  if (!bound) return null
  if (publicAddress) return publicAddress
  return isLoopbackAuthority(bound) ? bound : null
}

function authorityOf(info: AddressInfo): string {
  return info.family === 'IPv6' ? `[${info.address}]:${info.port}` : `${info.address}:${info.port}`
}

function parseListen(addr: string): { host: string; port: number } {
  const u = new URL(`http://${addr}`)
  return { host: u.hostname.replace(/^\[|\]$/g, ''), port: u.port === '' ? 0 : Number(u.port) }
}

interface SocketState {
  bucket: string
  ip: string | null
  grants: Map<string, GrantRecord>
  authenticated: boolean
  /** Streams to end when the socket loses its last grant on their target. */
  targetWatchers: Set<{ target: DirectTarget; ended: () => void }>
}

function covers(resource: GrantRecord['resource'], target: DirectTarget): boolean {
  return resource.kind === 'pty'
    ? target.kind === 'pty' && resource.sessionId === target.sessionId
    : target.kind === 'chat' && resource.tabId === target.tabId
}

/** Same session, or same tab (any epoch). */
function sameResource(a: GrantRecord['resource'], b: GrantRecord['resource']): boolean {
  return a.kind === 'pty'
    ? b.kind === 'pty' && a.sessionId === b.sessionId
    : b.kind === 'chat' && a.tabId === b.tabId
}

/** End the streams whose target this socket no longer holds any grant on. */
function endUncovered(state: SocketState): void {
  for (const watcher of [...state.targetWatchers]) {
    if ([...state.grants.values()].some((g) => covers(g.resource, watcher.target))) continue
    state.targetWatchers.delete(watcher)
    watcher.ended()
  }
}

function view(record: GrantRecord, now: number): DirectGrantView {
  return {
    grantId: record.grantId,
    resource: record.resource,
    expiresInMs: Math.max(0, Math.round(record.expiresAt - now))
  }
}

export async function createDirectListener(
  options: DirectListenerOptions
): Promise<DirectListener> {
  const limits: DirectListenerLimits = { ...DEFAULT_DIRECT_LIMITS, ...options.limits }
  const minute = (max: number): RateRule => ({ max, windowMs: 60_000 })
  const limiter = createFixedWindowLimiter()
  const auditLimiter = createFixedWindowLimiter()
  const sockets = new Map<ServedSocket, SocketState>()
  const openPerBucket = new Map<string, number>()

  const refuse = (refusal: RateLimitRefusal): void => {
    const key = `${refusal.limit}|${addressBucket(refusal.address)}`
    if (!auditLimiter.consume(key, minute(1)).allowed) return
    options.audit?.(refusal)
    options.log('direct link refused by a flood limit', {
      limit: refusal.limit,
      address: refusal.address
    })
  }

  const router = createDirectRouter(options.services)
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.maxMessageBytes })

  function closeUnauthorized(ws: ServedSocket, reason: string): void {
    if (ws.readyState === 1 || ws.readyState === 0) {
      ws.close(DIRECT_CLOSE_UNAUTHORIZED, reason)
    }
  }

  function socketFor(ws: ServedSocket, state: SocketState): DirectSocket {
    return {
      authorize(token) {
        const record = options.grants.authenticate(token)
        if (!record) {
          limiter.hit(`auth|${state.bucket}`, minute(limits.failedAuthsPerMinute))
          return null
        }
        // Newest wins: drop what this socket held on the same session or tab (a renewal,
        // or a chat grant from an older epoch that would shadow this one).
        for (const [id, held] of state.grants) {
          if (id !== record.grantId && sameResource(held.resource, record.resource)) {
            state.grants.delete(id)
          }
        }
        if (!state.grants.has(record.grantId) && state.grants.size >= limits.grantsPerSocket) {
          return null
        }
        state.grants.set(record.grantId, record)
        state.authenticated = true
        return view(record, performance.now())
      },
      release(target) {
        let hit = false
        for (const [id, held] of state.grants) {
          if (covers(held.resource, target)) hit = state.grants.delete(id) || hit
        }
        if (hit) endUncovered(state)
        return hit
      },
      grantFor(target) {
        for (const record of state.grants.values()) {
          // Asked of the store, not the socket's copy: an expiry the sweep has not
          // reached yet still counts as ended.
          if (covers(record.resource, target) && options.grants.get(record.grantId)) {
            return { grantId: record.grantId, hubKey: record.hubKey, resource: record.resource }
          }
        }
        return null
      },
      onTargetEnded(target, ended) {
        const watcher = { target, ended }
        state.targetWatchers.add(watcher)
        return () => {
          state.targetWatchers.delete(watcher)
        }
      }
    }
  }

  const handle = getWSConnectionHandler({
    wss,
    router,
    keepAlive: { enabled: true, pingMs: 30_000, pongWaitMs: 10_000 },
    createContext: ({ res, info }): DirectContext => {
      const ws = res as unknown as ServedSocket
      const state = sockets.get(ws)
      if (!state) throw new TRPCError({ code: 'UNAUTHORIZED' })
      const socket = socketFor(ws, state)
      const token = info.connectionParams?.token
      if (!state.authenticated && (typeof token !== 'string' || !socket.authorize(token))) {
        closeUnauthorized(ws, 'unknown or expired capability')
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'unknown or expired capability' })
      }
      return { socket }
    }
  })

  /**
   * The per-address admission checks, before a socket is served (WebSocket upgrade
   * or data channel). False = refused, audited.
   */
  function admit(ip: string | null, route: string): { ok: true } | { ok: false; status: number } {
    const bucket = addressBucket(ip)
    if (!limiter.check(`auth|${bucket}`, minute(limits.failedAuthsPerMinute)).allowed) {
      refuse({
        limit: 'computer.direct.failed_auth_per_address',
        address: ip,
        route,
        max: limits.failedAuthsPerMinute,
        windowSec: 60
      })
      return { ok: false, status: 429 }
    }
    if ((openPerBucket.get(bucket) ?? 0) >= limits.socketsPerAddress) {
      refuse({
        limit: 'computer.direct.sockets_per_address',
        address: ip,
        route,
        max: limits.socketsPerAddress
      })
      return { ok: false, status: 429 }
    }
    if (!limiter.consume(`upgrade|${bucket}`, minute(limits.upgradesPerMinute)).allowed) {
      refuse({
        limit: 'computer.direct.upgrades_per_address',
        address: ip,
        route,
        max: limits.upgradesPerMinute,
        windowSec: 60
      })
      return { ok: false, status: 429 }
    }
    return { ok: true }
  }

  /** Serve one admitted socket, whichever transport brought it. */
  function serve(ws: ServedSocket, req: IncomingMessage, ip: string | null, route: string): void {
    const bucket = addressBucket(ip)
    const state: SocketState = {
      bucket,
      ip,
      grants: new Map(),
      authenticated: false,
      targetWatchers: new Set()
    }
    sockets.set(ws, state)
    openPerBucket.set(bucket, (openPerBucket.get(bucket) ?? 0) + 1)
    const deadline = setTimeout(() => {
      if (!state.authenticated) closeUnauthorized(ws, 'no capability presented')
    }, limits.authDeadlineMs)
    deadline.unref?.()
    let messages = 0
    let windowEnds = Date.now() + 10_000
    // Before tRPC's own listener: a flood is cut off before it is parsed.
    ws.on('message', () => {
      const t = Date.now()
      if (t >= windowEnds) {
        messages = 0
        windowEnds = t + 10_000
      }
      if (++messages > limits.messagesPerSocketPer10s) {
        refuse({
          limit: 'computer.direct.messages_per_socket',
          address: ip,
          route,
          max: limits.messagesPerSocketPer10s,
          windowSec: 10
        })
        ws.close(1008, 'message rate')
      }
    })
    ws.once('close', () => {
      clearTimeout(deadline)
      sockets.delete(ws)
      const open = (openPerBucket.get(bucket) ?? 1) - 1
      if (open <= 0) openPerBucket.delete(bucket)
      else openPerBucket.set(bucket, open)
    })
    handle(ws as WebSocket, req)
  }

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    serve(ws, req, req.socket.remoteAddress ?? null, `WS ${DIRECT_PATH}`)
  })

  const stopDrops = options.grants.onDropped((dropped) => {
    const ids = new Set(dropped.map((g) => g.grantId))
    for (const [ws, state] of sockets) {
      let hit = false
      for (const id of ids) hit = state.grants.delete(id) || hit
      if (!hit) continue
      endUncovered(state)
      if (state.grants.size === 0) closeUnauthorized(ws, 'capability ended')
    }
  })

  function refuseUpgrade(socket: Duplex, status: number, text: string): void {
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  }

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    if (req.method === 'GET' && path === DIRECT_HEALTH_PATH) {
      const ip = req.socket.remoteAddress ?? null
      const bucket = addressBucket(ip)
      if (!limiter.consume(`health|${bucket}`, minute(limits.healthPerMinute)).allowed) {
        refuse({
          limit: 'computer.direct.health_per_address',
          address: ip,
          route: `GET ${DIRECT_HEALTH_PATH}`,
          max: limits.healthPerMinute,
          windowSec: 60
        })
        res.writeHead(429).end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ protocol: DIRECT_ROUTER_PROTOCOL }))
      return
    }
    res.writeHead(404).end()
  })

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? '/').split('?')[0]
    if (path !== DIRECT_PATH) return refuseUpgrade(socket, 404, 'Not Found')
    const admitted = admit(req.socket.remoteAddress ?? null, `WS ${DIRECT_PATH}`)
    if (!admitted.ok) return refuseUpgrade(socket, admitted.status, 'Too Many Requests')
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  const { host, port } = parseListen(options.listenAddress)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const boundAddress = authorityOf(server.address() as AddressInfo)
  const advertisedAddress = advertisedDirectAddress(boundAddress, options.publicAddress)
  options.log('direct link listening', { boundAddress, advertisedAddress })

  return {
    boundAddress,
    advertisedAddress,
    serveChannel(socket, meta) {
      const route = `RTC ${DIRECT_PATH}`
      if (!admit(meta.ip, route).ok) {
        socket.close(1008, 'refused')
        return false
      }
      // tRPC's handler reads the request only for `connectionParams=1` (the first
      // frame carries the capability) — the same as a WebSocket client sends.
      const req = {
        url: `${DIRECT_PATH}?connectionParams=1`,
        headers: { host: 'direct.rtc' },
        socket: { remoteAddress: meta.ip ?? undefined }
      } as unknown as IncomingMessage
      serve(socket, req, meta.ip, route)
      return true
    },
    async close() {
      stopDrops()
      for (const ws of sockets.keys()) ws.terminate()
      wss.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
