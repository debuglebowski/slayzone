/**
 * The client side of the direct link (docs/direct-link.md): reach terminal and chat
 * data on the computer that holds them, and fall back to the hub relay whenever
 * that is not possible. One manager per hub; desktop and mobile share it.
 *
 * `acquire(target)`:
 *  1. asks the hub for a capability (`computers.issueDirectLink`);
 *  2. probes the computer's plain-HTTP health path;
 *  3. opens (or reuses) ONE socket per computer, presenting the capability;
 *  4. returns a lease, or null — and null always means "use the relay".
 *
 * **A dead computer never costs a failed WebSocket.** Chromium delays every new
 * WebSocket a renderer opens by that renderer's recent failed connects, the hub's
 * socket included (connectPacing.ts). So no direct socket is ever opened, or
 * re-opened by the tRPC client's own reconnect loop, without a fresh successful
 * HTTP probe first. A failure backs off per computer: 60 s, doubling to 10 min,
 * cleared when the computer reconnects to the hub.
 *
 * **Leases renew through the hub** at half their lifetime, so every renewal re-runs
 * the hub's gates. A lease is lost, and its holder goes back to the relay and may
 * acquire again, when:
 *  - the socket closes (a local computer restart also moves its port);
 *  - a renewal is refused;
 *  - the computer reconnects to the hub.
 *
 * @module transport/client/direct-link
 */
import { createTRPCClient, createWSClient, wsLink, type TRPCClient } from '@trpc/client'
import { hubUrlFromAddr } from '@slayzone/platform/hub-addr'
import { wireSuperjson } from '@slayzone/trpc-server/wire'
import type { DirectRouter, DirectTarget } from '../direct/router'

export const DIRECT_LINK_PATH = '/direct/v1'
export const DIRECT_LINK_HEALTH_PATH = '/direct/v1/health'

/** The hub's answer (`@slayzone/computers` `DirectLinkIssueResult`, structurally). */
export type DirectIssueResult =
  | {
      available: true
      computerId: string
      address: string
      token: string
      grantId: string
      expiresInMs: number
      protocol: number
    }
  | { available: false; reason: string }

/** One socket to one computer. */
export interface DirectConnection {
  client: TRPCClient<DirectRouter>
  /** Called once when the socket is gone for good (the manager never reconnects it). */
  onClose(cb: () => void): void
  close(): void
}

export interface DirectLease {
  readonly computerId: string
  readonly client: TRPCClient<DirectRouter>
  /** Called once when the lease can no longer be used; returns unsubscribe. */
  onLost(cb: (reason: DirectLeaseLostReason) => void): () => void
  release(): void
}

export type DirectLeaseLostReason =
  | 'closed'
  | 'renewal-refused'
  | 'computer-reconnected'
  | 'disposed'

export interface DirectLinkManagerOptions {
  issue(target: DirectTarget): Promise<DirectIssueResult>
  /**
   * Is the computer's listener at `address` worth a socket now? Default: a plain
   * HTTP `fetch` of its health path with a deadline (mobile, node). The desktop asks
   * its main process, which also checks the document's CSP (`prepareDirectLink`).
   */
  probe?: (address: string) => Promise<boolean>
  /** Default: a tRPC ws client that never reconnects without the probe saying yes. */
  openConnection?: (opts: {
    url: string
    token: string
    probe: () => Promise<boolean>
  }) => DirectConnection
  connectDeadlineMs?: number
  backoffInitialMs?: number
  backoffMaxMs?: number
  /** Keep an unused socket this long, so a tab switch does not reconnect. */
  lingerMs?: number
  log?: (message: string, detail?: Record<string, unknown>) => void
}

export interface DirectLinkManager {
  acquire(target: DirectTarget): Promise<DirectLease | null>
  /** The computer (re)connected to the hub: its address may have moved. */
  computerConnected(computerId: string): void
  dispose(): void
}

const DEFAULTS = {
  connectDeadlineMs: 3_000,
  backoffInitialMs: 60_000,
  backoffMaxMs: 600_000,
  lingerMs: 30_000
}

/** True when an issue call failed because the hub has no such procedure (older hub). */
function isUnsupportedHub(err: unknown): boolean {
  const e = err as { data?: { code?: string }; message?: string } | null
  return e?.data?.code === 'NOT_FOUND' || /No "mutation"-procedure/.test(e?.message ?? '')
}

export async function defaultDirectProbe(address: string, deadlineMs = 3_000): Promise<boolean> {
  const healthUrl = hubUrlFromAddr(address, 'http', DIRECT_LINK_HEALTH_PATH)
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), deadlineMs)
  try {
    // `no-cors`: an opaque answer is still an answer; only a network failure throws.
    await fetch(healthUrl, { mode: 'no-cors', cache: 'no-store', signal: abort.signal })
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** Never reconnects on its own; every open is probed first. */
export function openDirectConnection(opts: {
  url: string
  token: string
  probe: () => Promise<boolean>
}): DirectConnection {
  const closeListeners: Array<() => void> = []
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    wsClient.close()
    for (const cb of closeListeners.splice(0)) cb()
  }
  const wsClient = createWSClient({
    url: async () => {
      if (closed || !(await opts.probe())) throw new Error('direct link not reachable')
      return opts.url
    },
    connectionParams: { token: opts.token },
    // The manager decides when to try again (after a probe and a fresh grant).
    retryDelayMs: () => 2_147_483_647,
    onClose: () => queueMicrotask(close)
  })
  return {
    client: createTRPCClient<DirectRouter>({
      links: [wsLink({ client: wsClient, transformer: wireSuperjson })]
    }),
    onClose: (cb) => {
      if (closed) cb()
      else closeListeners.push(cb)
    },
    close
  }
}

interface Socket {
  key: string
  computerId: string
  address: string
  connection: DirectConnection
  leases: Set<LeaseState>
  linger: ReturnType<typeof setTimeout> | null
}

interface LeaseState {
  target: DirectTarget
  socket: Socket
  renew: ReturnType<typeof setTimeout> | null
  lostListeners: Set<(reason: DirectLeaseLostReason) => void>
  done: boolean
}

export function createDirectLinkManager(options: DirectLinkManagerOptions): DirectLinkManager {
  const cfg = { ...DEFAULTS, ...options }
  const probe = options.probe ?? ((url: string) => defaultDirectProbe(url, cfg.connectDeadlineMs))
  const open = options.openConnection ?? openDirectConnection
  const log = options.log ?? (() => undefined)
  const sockets = new Map<string, Socket>()
  const backoff = new Map<string, { until: number; delay: number }>()
  /** The computer each target was last found on: a blocked one is not asked again. */
  const lastComputer = new Map<string, string>()
  const targetKey = (t: DirectTarget): string =>
    t.kind === 'pty' ? `pty:${t.sessionId}` : `chat:${t.tabId}`
  let hubUnsupported = false
  let disposed = false

  function blocked(computerId: string): boolean {
    const b = backoff.get(computerId)
    return b !== undefined && Date.now() < b.until
  }

  function fail(computerId: string, why: string): null {
    const prev = backoff.get(computerId)
    const delay = prev ? Math.min(prev.delay * 2, cfg.backoffMaxMs) : cfg.backoffInitialMs
    backoff.set(computerId, { until: Date.now() + delay, delay })
    log('direct link unavailable, using the hub relay', { computerId, why, retryInMs: delay })
    return null
  }

  function lose(lease: LeaseState, reason: DirectLeaseLostReason): void {
    if (lease.done) return
    lease.done = true
    if (lease.renew) clearTimeout(lease.renew)
    lease.socket.leases.delete(lease)
    for (const cb of [...lease.lostListeners]) cb(reason)
    lease.lostListeners.clear()
  }

  function dropSocket(socket: Socket, reason: DirectLeaseLostReason): void {
    if (sockets.get(socket.key) === socket) sockets.delete(socket.key)
    if (socket.linger) clearTimeout(socket.linger)
    for (const lease of [...socket.leases]) lose(lease, reason)
    socket.connection.close()
  }

  function scheduleRenewal(lease: LeaseState, expiresInMs: number): void {
    lease.renew = setTimeout(
      () => {
        lease.renew = null
        void renew(lease)
      },
      Math.max(1_000, Math.floor(expiresInMs / 2))
    )
  }

  async function renew(lease: LeaseState): Promise<void> {
    if (lease.done) return
    const next = await options.issue(lease.target).catch(() => null)
    if (lease.done) return
    if (
      !next ||
      !next.available ||
      next.computerId !== lease.socket.computerId ||
      next.address !== lease.socket.address
    ) {
      lose(lease, 'renewal-refused')
      return
    }
    try {
      await lease.socket.connection.client.authorize.mutate({ token: next.token })
      scheduleRenewal(lease, next.expiresInMs)
    } catch {
      lose(lease, 'renewal-refused')
    }
  }

  function withDeadline<T>(work: Promise<T>): Promise<T | 'timeout'> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve('timeout'), cfg.connectDeadlineMs)
      work.then(
        (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        (e: unknown) => {
          clearTimeout(timer)
          reject(e)
        }
      )
    })
  }

  async function socketFor(
    issued: Extract<DirectIssueResult, { available: true }>
  ): Promise<{ socket: Socket; fresh: boolean } | null> {
    const key = `${issued.computerId}|${issued.address}`
    const existing = sockets.get(key)
    if (existing) return { socket: existing, fresh: false }
    if (!(await probe(issued.address))) return fail(issued.computerId, 'probe')
    const connection = open({
      url: hubUrlFromAddr(issued.address, 'ws', DIRECT_LINK_PATH),
      token: issued.token,
      probe: () => probe(issued.address)
    })
    const ready = await withDeadline(connection.client.ping.query()).catch(() => 'failed' as const)
    if (ready === 'timeout' || ready === 'failed') {
      connection.close()
      return fail(issued.computerId, ready === 'timeout' ? 'deadline' : 'refused')
    }
    const socket: Socket = {
      key,
      computerId: issued.computerId,
      address: issued.address,
      connection,
      leases: new Set(),
      linger: null
    }
    connection.onClose(() => dropSocket(socket, 'closed'))
    sockets.set(key, socket)
    backoff.delete(issued.computerId)
    return { socket, fresh: true }
  }

  return {
    async acquire(target) {
      if (disposed || hubUnsupported) return null
      const known = lastComputer.get(targetKey(target))
      if (known && blocked(known)) return null
      let issued: DirectIssueResult
      try {
        issued = await options.issue(target)
      } catch (err) {
        if (isUnsupportedHub(err)) hubUnsupported = true
        return null
      }
      if (!issued.available || disposed) return null
      lastComputer.set(targetKey(target), issued.computerId)
      if (blocked(issued.computerId) && !sockets.has(`${issued.computerId}|${issued.address}`)) {
        return null
      }
      const got = await socketFor(issued)
      if (!got) return null
      const { socket } = got
      if (!got.fresh) {
        const ok = await withDeadline(
          socket.connection.client.authorize.mutate({ token: issued.token })
        ).catch(() => 'failed' as const)
        if (ok === 'timeout' || ok === 'failed') return null
      }
      if (socket.linger) {
        clearTimeout(socket.linger)
        socket.linger = null
      }
      const lease: LeaseState = {
        target,
        socket,
        renew: null,
        lostListeners: new Set(),
        done: false
      }
      socket.leases.add(lease)
      scheduleRenewal(lease, issued.expiresInMs)
      return {
        computerId: socket.computerId,
        client: socket.connection.client,
        onLost(cb) {
          if (lease.done) {
            cb('closed')
            return () => undefined
          }
          lease.lostListeners.add(cb)
          return () => lease.lostListeners.delete(cb)
        },
        release() {
          if (lease.done) return
          lease.done = true
          if (lease.renew) clearTimeout(lease.renew)
          socket.leases.delete(lease)
          lease.lostListeners.clear()
          if (socket.leases.size === 0 && !socket.linger) {
            socket.linger = setTimeout(() => {
              socket.linger = null
              if (socket.leases.size === 0) dropSocket(socket, 'closed')
            }, cfg.lingerMs)
          }
        }
      }
    },

    computerConnected(computerId) {
      backoff.delete(computerId)
      for (const socket of [...sockets.values()]) {
        if (socket.computerId === computerId) dropSocket(socket, 'computer-reconnected')
      }
    },

    dispose() {
      disposed = true
      for (const socket of [...sockets.values()]) dropSocket(socket, 'disposed')
    }
  }
}
