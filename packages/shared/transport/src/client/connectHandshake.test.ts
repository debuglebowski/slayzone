/**
 * One WebSocket attempt whose opening handshake never finishes must not freeze a hub's
 * client.
 *
 * WHY. @trpc/client has no handshake timeout, and every connect path — the reconnect
 * loop and every query's `open()` — joins the ONE in-flight attempt (`WsConnection`'s
 * `openPromise`). A socket that stays CONNECTING therefore parks every operation until
 * the browser gives up on it (Chromium: 240s), while the hub is up and its `/health`
 * answers. That is what "Hub unreachable — … did not connect within 15000ms
 * (Initialization error)" for 75s+ after a hub restart was.
 *
 * Real tRPC client against a real `ws` + tRPC hub on one port, real timers, short
 * watchdog constants; the probe is a real HTTP `/health` request like main's.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { WebSocketServer } from 'ws'
import type { TRPCClient } from '@trpc/client'
import { initTRPC } from '@trpc/server'
import { applyWSSHandler } from '@trpc/server/adapters/ws'
import { wireSuperjson } from '@slayzone/trpc-server/wire'
import { createTrpcWsClient } from './runtime'
import { type HubConnectProbe, setHubConnectProbe } from './connectPacing'
import { type HubConnectAbort, setHubConnectAbortListener } from './connectHandshake'
import { _resetHubConnectTraces, getHubConnectTrace } from './connectTrace'

// The client's own wire format, so answers decode as they do from a real hub.
const t = initTRPC.create({ transformer: wireSuperjson })
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

interface HubStats {
  upgrades: number
  health: number
  /** `ticks` subscriptions this hub process started. */
  subscribes: number
}

function makeRouter(stats: HubStats) {
  return t.router({
    ping: t.procedure.query(() => 'pong'),
    /** Long enough to still be in flight when the reconnect loop's timer fires. */
    slow: t.procedure.query(async () => {
      await sleep(2500)
      return 'slow'
    }),
    ticks: t.procedure.subscription(async function* (opts) {
      stats.subscribes++
      while (!opts.signal?.aborted) {
        yield Date.now()
        await sleep(100)
      }
    })
  })
}
type TestClient = TRPCClient<ReturnType<typeof makeRouter>>

interface HubOpts {
  port?: number
  /** The first n upgrades this hub process receives are never answered. */
  holdUpgrades?: number
  /** Every upgrade is answered this late (a socket waiting before its handshake). */
  upgradeDelayMs?: number
  /** Start with the event loop "blocked": upgrades AND /health wait for `release()`. */
  busy?: boolean
}

interface TestHub {
  port: number
  url: string
  stats: HubStats
  /** Unblock a `busy` hub: queued upgrades are answered first, then /health. */
  release: () => void
  /** Stop like `apps/hub` `stop()`: reconnect broadcast, close, then the process ends. */
  stop: () => Promise<void>
}

const hubs = new Set<TestHub>()

async function startHub(o: HubOpts = {}): Promise<TestHub> {
  const conns = new Set<Socket>()
  const stats: HubStats = { upgrades: 0, health: 0, subscribes: 0 }
  let held = 0
  let releaseGate: () => void = () => undefined
  const gate = o.busy
    ? new Promise<void>((r) => {
        releaseGate = r
      })
    : null
  const srv = http.createServer((req, res) => {
    if (req.url !== '/health') {
      res.writeHead(404).end()
      return
    }
    stats.health++
    const answer = () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
    }
    // Upgrades queued behind the same gate are answered first (setImmediate).
    if (gate) void gate.then(() => setImmediate(answer))
    else answer()
  })
  srv.on('connection', (c) => {
    conns.add(c)
    c.on('close', () => conns.delete(c))
  })
  const wss = new WebSocketServer({ noServer: true })
  const handler = applyWSSHandler({ wss, router: makeRouter(stats) })
  srv.on('upgrade', (req, socket, head) => {
    stats.upgrades++
    if (held < (o.holdUpgrades ?? 0)) {
      held++
      return
    }
    const accept = () => {
      if (socket.destroyed) return
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
    }
    if (gate) void gate.then(accept)
    else if (o.upgradeDelayMs) setTimeout(accept, o.upgradeDelayMs)
    else accept()
  })
  await new Promise<void>((resolve) => srv.listen(o.port ?? 0, '127.0.0.1', () => resolve()))
  const port = (srv.address() as AddressInfo).port
  let stopped = false
  const hub: TestHub = {
    port,
    url: `ws://127.0.0.1:${port}/trpc?windowId=1`,
    stats,
    release: () => releaseGate(),
    stop: async () => {
      if (stopped) return
      stopped = true
      hubs.delete(hub)
      handler.broadcastReconnectNotification()
      wss.close()
      await sleep(20)
      srv.close()
      for (const c of conns) c.destroy()
    }
  }
  hubs.add(hub)
  return hub
}

/** Main's probe, reproduced: GET /health, up on a 200, down on anything else. */
function httpProbe(timeoutMs = 3000): HubConnectProbe {
  return (wsUrl) =>
    new Promise((resolve) => {
      const u = new URL(wsUrl)
      const req = http.get(
        { host: u.hostname, port: u.port, path: '/health', timeout: timeoutMs },
        (res) => {
          res.resume()
          resolve(res.statusCode === 200)
        }
      )
      req.on('error', () => resolve(false))
      req.on('timeout', () => {
        req.destroy()
        resolve(false)
      })
    })
}

/** Count every socket the client constructs (the watchdog must use the global). */
function countSockets(): { count: () => number } {
  const Real = globalThis.WebSocket
  let constructed = 0
  class CountingWebSocket extends Real {
    constructor(u: string | URL, protocols?: string | string[]) {
      super(u, protocols)
      constructed++
    }
  }
  vi.stubGlobal('WebSocket', CountingWebSocket)
  return { count: () => constructed }
}

/**
 * Query every 100ms (the app keeps issuing operations) until one succeeds. Resolves
 * with the ms it took; rejects when `budgetMs` passes without a success.
 */
async function firstSuccess(client: TestClient, budgetMs: number): Promise<number> {
  const start = Date.now()
  let ok = false
  while (!ok) {
    if (Date.now() - start > budgetMs) throw new Error(`no successful call within ${budgetMs}ms`)
    void client.ping.query().then(
      () => {
        ok = true
      },
      () => undefined
    )
    await sleep(100)
  }
  return Date.now() - start
}

const clients: Array<{ close: () => Promise<void> }> = []

function makeClient(
  url: string,
  timing: { hedgeAfterMs: number; deadlineMs: number }
): { client: TestClient; wsClient: { close: () => Promise<void> } } {
  const created = createTrpcWsClient({ url, connectDeadlineMs: 60_000, handshakeTiming: timing })
  clients.push(created.wsClient)
  return { client: created.client as unknown as TestClient, wsClient: created.wsClient }
}

afterEach(async () => {
  setHubConnectProbe(null)
  setHubConnectAbortListener(null)
  _resetHubConnectTraces()
  vi.unstubAllGlobals()
  // Hubs first: ending them fails any handshake still held, which `close()` waits on.
  for (const h of [...hubs]) await h.stop()
  for (const c of clients.splice(0)) await c.close().catch(() => null)
})

describe('a hub connect attempt whose handshake does not finish', () => {
  it('after a hub restart, a stuck handshake is replaced as soon as /health answers', async () => {
    setHubConnectProbe(httpProbe())
    const first = await startHub()
    // The hard deadline is far away: recovery here must come from the probe.
    const { client } = makeClient(first.url, { hedgeAfterMs: 150, deadlineMs: 30_000 })
    await client.ping.query()

    await first.stop()
    await sleep(300)
    const second = await startHub({ port: first.port, holdUpgrades: 1 })

    const aborts: HubConnectAbort[] = []
    setHubConnectAbortListener((a) => aborts.push(a))

    await firstSuccess(client, 4000)
    // The held socket was given up and a fresh one opened.
    expect(second.stats.upgrades).toBeGreaterThanOrEqual(2)
    expect(aborts).toEqual([
      expect.objectContaining({ url: first.url, reason: 'hedge', waitedMs: expect.any(Number) })
    ])
    // The trace tells the story: the stuck attempt was hedged, the next one opened.
    const outcomes = getHubConnectTrace(first.url).map((a) => a.outcome)
    const hedged = outcomes.lastIndexOf('hedge')
    expect(hedged).toBeGreaterThan(0)
    expect(outcomes.slice(hedged + 1)).toContain('open')
    expect(outcomes[0]).toBe('open')
  }, 15_000)

  it('without a probe (fork, web shell) the hard deadline ends a stuck handshake', async () => {
    const hub = await startHub({ holdUpgrades: 1 })
    // 1.5s: far above a loopback handshake even on a saturated box, so only the held
    // socket is cut.
    const { client } = makeClient(hub.url, { hedgeAfterMs: 100, deadlineMs: 1500 })
    await firstSuccess(client, 5000)
    expect(hub.stats.upgrades).toBeGreaterThanOrEqual(2)
    const trace = getHubConnectTrace(hub.url)
    expect(trace[0]).toMatchObject({ outcome: 'deadline', onSchedule: true, probe: null })
    expect(trace[0].settledAt! - trace[0].socketAt!).toBeGreaterThanOrEqual(1400)
    expect(trace.at(-1)?.outcome).toBe('open')
  }, 15_000)

  it('a hub that is busy (its /health blocked too) is waited for, never hedged', async () => {
    setHubConnectProbe(httpProbe())
    const sockets = countSockets()
    const hub = await startHub({ busy: true })
    const { client } = makeClient(hub.url, { hedgeAfterMs: 100, deadlineMs: 30_000 })
    const answered = client.ping.query()
    await sleep(800)
    expect(hub.stats.health).toBeGreaterThanOrEqual(1)
    hub.release()
    await expect(answered).resolves.toBe('pong')
    expect(sockets.count()).toBe(1)
    expect(hub.stats.upgrades).toBe(1)
  }, 15_000)

  it('a slow but healthy handshake costs a bounded number of extra connects', async () => {
    setHubConnectProbe(httpProbe())
    const sockets = countSockets()
    // Every handshake takes 450ms; /health answers at once (a socket held up before its
    // handshake, e.g. in Chromium's per-process throttle).
    const hub = await startHub({ upgradeDelayMs: 450 })
    const { client } = makeClient(hub.url, { hedgeAfterMs: 100, deadlineMs: 30_000 })
    await firstSuccess(client, 6000)
    // Hedges at 100, 200, 400ms (the grace doubles), then 800ms > 450ms: it opens.
    expect(sockets.count()).toBeGreaterThanOrEqual(2)
    expect(sockets.count()).toBeLessThanOrEqual(4)
  }, 15_000)

  it('a healthy restart reconnects with one socket and no hedge', async () => {
    setHubConnectProbe(httpProbe())
    const first = await startHub()
    const { client } = makeClient(first.url, { hedgeAfterMs: 150, deadlineMs: 30_000 })
    await client.ping.query()
    await first.stop()
    await sleep(300)
    const second = await startHub({ port: first.port })
    const ms = await firstSuccess(client, 4000)
    expect(ms).toBeLessThan(1000)
    expect(second.stats.upgrades).toBe(1)
  }, 15_000)
})

describe('after a query reconnected while the reconnect loop slept', () => {
  // The hub restarts; while the loop sleeps toward its next attempt, a query (the probe
  // having said "up") reconnects. The loop's job is done at that point.

  it('the loop does not close the healthy socket when it wakes (in-flight calls survive)', async () => {
    setHubConnectProbe(httpProbe())
    const first = await startHub()
    const { client } = makeClient(first.url, { hedgeAfterMs: 150, deadlineMs: 30_000 })
    await client.ping.query()
    await first.stop()
    // Loop: attempt 0 (now) fails against the stopped hub; attempt 1 is due in 2s.
    await sleep(300)
    const second = await startHub({ port: first.port })
    await firstSuccess(client, 1500)
    // In flight across the loop's 2s wake-up.
    await expect(client.slow.query()).resolves.toBe('slow')
    await sleep(500)
    expect(second.stats.upgrades).toBe(1)
  }, 20_000)

  it("a live subscription is resent on the socket the query opened, not at the loop's next tick", async () => {
    setHubConnectProbe(httpProbe())
    const first = await startHub()
    const { client } = makeClient(first.url, { hedgeAfterMs: 150, deadlineMs: 30_000 })
    const seen: number[] = []
    const sub = client.ticks.subscribe(undefined, { onData: (v) => seen.push(v) })
    try {
      await client.ping.query()
      await first.stop()
      // Down for 2.5s: loop attempts 0 (0s) and 1 (2s) fail, attempt 2 is due at 6s.
      await sleep(2500)
      const second = await startHub({ port: first.port })
      await firstSuccess(client, 1500)
      const recoveredAt = Date.now()
      while (second.stats.subscribes === 0 && Date.now() - recoveredAt < 2000) await sleep(50)
      expect(second.stats.subscribes).toBe(1)
      const before = seen.length
      await sleep(400)
      expect(seen.length).toBeGreaterThan(before)
      expect(second.stats.upgrades).toBe(1)
    } finally {
      sub.unsubscribe()
    }
  }, 20_000)
})

describe('connect pacing with a probe that is wrong', () => {
  it("a slow probe that says down does not starve the reconnect loop's own attempts", async () => {
    // Main busy: every probe takes 300ms and answers "down" although the hub is up.
    // The loop's scheduled attempts are never probed, so they must still reach it.
    setHubConnectProbe(async () => {
      await sleep(300)
      return false
    })
    const reserved = await startHub()
    const port = reserved.port
    await reserved.stop()
    const sockets = countSockets()
    const url = `ws://127.0.0.1:${port}/trpc?windowId=1`
    // Constructor attempt and loop attempt 0 are refused; attempt 1 is due at 2s.
    const { client } = makeClient(url, { hedgeAfterMs: 100, deadlineMs: 30_000 })
    await sleep(200)
    await startHub({ port })
    // Queries keep coming (each one probes): the 2s attempt must not be lost to them.
    await firstSuccess(client, 7000)
    expect(sockets.count()).toBeGreaterThanOrEqual(3)
    // Queries between the loop's attempts were probed and opened no socket.
    const trace = getHubConnectTrace(url)
    const deferred = trace.filter((a) => a.outcome === 'deferred')
    expect(deferred.length).toBeGreaterThan(0)
    for (const a of deferred) {
      expect(a).toMatchObject({ onSchedule: false, socketAt: null, probe: { up: false } })
    }
    expect(trace.at(-1)?.outcome).toBe('open')
  }, 20_000)
})
