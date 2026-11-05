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
import type { DirectIssueTarget, DirectRouter, DirectTarget } from '../direct/router'

export {
  DIRECT_CALL_DEADLINE_MS,
  DirectDeadlineError,
  directCallFailure,
  withDirectDeadline
} from './direct-call'

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
  issue(target: DirectIssueTarget): Promise<DirectIssueResult>
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

/** One computer's direct-link state, for Diagnostics. */
export type DirectLinkComputerStatus =
  | { computerId: string; path: 'direct'; address: string; leases: number }
  | {
      computerId: string
      path: 'relay'
      /** Why the last attempt failed: no HTTP answer, no socket in time, refused. */
      reason: 'probe' | 'deadline' | 'refused'
      retryInMs: number
    }

export interface DirectLinkManager {
  acquire(target: DirectIssueTarget): Promise<DirectLease | null>
  /** Computers on the direct link, and those backing off to the relay. */
  status(): DirectLinkComputerStatus[]
  /** The computer (re)connected to the hub: its address may have moved. */
  computerConnected(computerId: string): void
  /** Told after `computerConnected`: a good moment for relaying holders to try again. */
  onComputerConnected(cb: (computerId: string) => void): () => void
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
/**
 * Client pings on the direct socket. A half-open socket (a NAT dropped the flow, the
 * network changed) brings no FIN; without pings the client would wait on it forever
 * while its sessions are kept off the relay. A missed pong closes the socket, which
 * ends its leases (back to the relay at once).
 */
export const DIRECT_KEEPALIVE = { intervalMs: 10_000, pongTimeoutMs: 5_000 }

export function openDirectConnection(opts: {
  url: string
  token: string
  probe: () => Promise<boolean>
  /** Default {@link DIRECT_KEEPALIVE}. */
  keepAlive?: { intervalMs: number; pongTimeoutMs: number }
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
    keepAlive: { enabled: true, ...(opts.keepAlive ?? DIRECT_KEEPALIVE) },
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
  target: DirectIssueTarget
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
  const backoff = new Map<
    string,
    { until: number; delay: number; why: 'probe' | 'deadline' | 'refused' }
  >()
  /** The computer each target was last found on: a blocked one is not asked again. */
  const lastComputer = new Map<string, string>()
  const targetKey = (t: DirectIssueTarget): string =>
    t.kind === 'pty' ? `pty:${t.sessionId}` : `chat:${t.tabId}`
  let hubUnsupported = false
  let disposed = false
  const connectedListeners = new Set<(computerId: string) => void>()

  function blocked(computerId: string): boolean {
    const b = backoff.get(computerId)
    return b !== undefined && Date.now() < b.until
  }

  function fail(computerId: string, why: 'probe' | 'deadline' | 'refused'): null {
    const prev = backoff.get(computerId)
    const delay = prev ? Math.min(prev.delay * 2, cfg.backoffMaxMs) : cfg.backoffInitialMs
    backoff.set(computerId, { until: Date.now() + delay, delay, why })
    log('direct link unavailable, using the hub relay', { computerId, why, retryInMs: delay })
    return null
  }

  /**
   * The lease leaves its socket. When it was the socket's last lease on its target,
   * the computer is told to drop that target's grants (they would otherwise stay on
   * the socket until their TTL, and renewals would pile them up to its cap).
   */
  function detach(lease: LeaseState, socketOpen: boolean): void {
    const { socket } = lease
    socket.leases.delete(lease)
    if (!socketOpen) return
    const key = targetKey(lease.target)
    if ([...socket.leases].some((l) => targetKey(l.target) === key)) return
    const target: DirectTarget =
      lease.target.kind === 'pty'
        ? { kind: 'pty', sessionId: lease.target.sessionId }
        : { kind: 'chat', tabId: lease.target.tabId }
    // Best-effort: a grant the computer keeps meanwhile is superseded by the next one
    // on the same target, and ends with its TTL.
    void Promise.resolve()
      .then(() => socket.connection.client.release.mutate(target))
      .catch(() => undefined)
  }

  function lose(lease: LeaseState, reason: DirectLeaseLostReason, socketOpen = true): void {
    if (lease.done) return
    lease.done = true
    if (lease.renew) clearTimeout(lease.renew)
    detach(lease, socketOpen)
    for (const cb of [...lease.lostListeners]) cb(reason)
    lease.lostListeners.clear()
  }

  function dropSocket(socket: Socket, reason: DirectLeaseLostReason): void {
    if (sockets.get(socket.key) === socket) sockets.delete(socket.key)
    if (socket.linger) clearTimeout(socket.linger)
    for (const lease of [...socket.leases]) lose(lease, reason, false)
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

  /**
   * Sockets being opened, per computer and address. Every acquire that arrives while
   * one opens waits for it (one probe, one socket): at boot every open tab acquires
   * at once, and a socket each would exceed the listener's per-address limit — a
   * refused upgrade is a failed WebSocket connect, which slows the hub's socket too.
   */
  const opening = new Map<string, Promise<Socket | null>>()

  async function socketFor(
    issued: Extract<DirectIssueResult, { available: true }>
  ): Promise<{ socket: Socket; fresh: boolean } | null> {
    const key = `${issued.computerId}|${issued.address}`
    const existing = sockets.get(key)
    if (existing) return { socket: existing, fresh: false }
    const pending = opening.get(key)
    if (pending) {
      // Opened with the opener's token: this caller authorizes its own on it.
      const socket = await pending
      return socket ? { socket, fresh: false } : null
    }
    const opened = openSocket(key, issued)
    opening.set(key, opened)
    try {
      const socket = await opened
      return socket ? { socket, fresh: true } : null
    } finally {
      opening.delete(key)
    }
  }

  async function openSocket(
    key: string,
    issued: Extract<DirectIssueResult, { available: true }>
  ): Promise<Socket | null> {
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
    return socket
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
          detach(lease, true)
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

    status() {
      const out: DirectLinkComputerStatus[] = []
      for (const socket of sockets.values()) {
        out.push({
          computerId: socket.computerId,
          path: 'direct',
          address: socket.address,
          leases: socket.leases.size
        })
      }
      const now = Date.now()
      for (const [computerId, b] of backoff) {
        if (b.until <= now || out.some((o) => o.computerId === computerId)) continue
        out.push({ computerId, path: 'relay', reason: b.why, retryInMs: b.until - now })
      }
      return out
    },

    computerConnected(computerId) {
      backoff.delete(computerId)
      for (const socket of [...sockets.values()]) {
        if (socket.computerId === computerId) dropSocket(socket, 'computer-reconnected')
      }
      for (const cb of [...connectedListeners]) cb(computerId)
    },

    onComputerConnected(cb) {
      connectedListeners.add(cb)
      return () => connectedListeners.delete(cb)
    },

    dispose() {
      disposed = true
      for (const socket of [...sockets.values()]) dropSocket(socket, 'disposed')
    }
  }
}

// ---------------------------------------------------------------------------
// One manager per hub, shared by every consumer in this client
// ---------------------------------------------------------------------------

/** The slice of a hub's tRPC client the registry uses. */
export interface DirectLinkHubClient {
  computers: {
    issueDirectLink: {
      mutate(input: { target: DirectIssueTarget }): Promise<DirectIssueResult>
    }
    onStatusChange: {
      subscribe(
        input: undefined,
        opts: { onData: (change: { computerId: string; connected: boolean }) => void }
      ): { unsubscribe(): void }
    }
  }
}

let installedProbe: ((address: string) => Promise<boolean>) | null = null

/**
 * Install (or clear) the process-wide direct-link probe — which also ENABLES the
 * direct link in this client: a host that installs none (the web shell, the
 * Chromium fork) stays on the hub relay. The desktop installs one that asks its
 * main process (CSP check + an HTTP probe that never touches the renderer's
 * WebSocket stack); mobile installs `defaultDirectProbe` (a plain fetch).
 */
export function setDirectLinkProbe(probe: ((address: string) => Promise<boolean>) | null): void {
  installedProbe = probe
}

/** Whether this client uses direct links at all (a probe is installed). */
export function isDirectLinkEnabled(): boolean {
  return installedProbe !== null
}

const managers = new Map<string, { manager: DirectLinkManager; stop: () => void }>()

/** The direct-link manager for one hub (created on first use). */
export function directLinkManagerFor(
  hubId: string,
  client: DirectLinkHubClient
): DirectLinkManager {
  const existing = managers.get(hubId)
  if (existing) return existing.manager
  const manager = createDirectLinkManager({
    issue: (target) => client.computers.issueDirectLink.mutate({ target }),
    probe: (address) => (installedProbe ? installedProbe(address) : Promise.resolve(false))
  })
  // A computer that (re)connects may have moved its port: drop sockets to the old
  // address and clear its backoff, so holders re-acquire at once.
  let sub: { unsubscribe(): void } | null = null
  try {
    sub = client.computers.onStatusChange.subscribe(undefined, {
      onData: (change) => {
        if (change.connected) manager.computerConnected(change.computerId)
      }
    })
  } catch {
    // An older hub without the subscription: holders still re-acquire on close.
  }
  managers.set(hubId, { manager, stop: () => sub?.unsubscribe() })
  return manager
}

const directUses = { pty: new Set<string>(), chat: new Set<string>() }

/** A terminal session or chat tab went onto (true) or off (false) the direct link. */
export function noteDirectUse(kind: 'pty' | 'chat', id: string, linked: boolean): void {
  if (linked) directUses[kind].add(id)
  else directUses[kind].delete(id)
}

/** How many terminals and chats are on the direct link now (Diagnostics). */
export function directUseCounts(): { terminals: number; chats: number } {
  return { terminals: directUses.pty.size, chats: directUses.chat.size }
}

/** Every hub's direct-link state (Diagnostics). */
export function directLinkStatus(): Array<{
  hubId: string
  computers: DirectLinkComputerStatus[]
}> {
  return [...managers].map(([hubId, { manager }]) => ({ hubId, computers: manager.status() }))
}

/** Test seam / hub removal. */
export function disposeDirectLinkManagers(): void {
  for (const { manager, stop } of managers.values()) {
    stop()
    manager.dispose()
  }
  managers.clear()
}

export {
  keepDirectLease,
  type DirectLeaseKeeper,
  type DirectLeaseKeeperOptions
} from './direct-lease-keeper'
