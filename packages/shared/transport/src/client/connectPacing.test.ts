/**
 * A hub that is DOWN must not be hammered with WebSocket connects.
 *
 * Why it matters beyond the dead hub itself: Chromium's network service
 * throttles every NEW WebSocket of a renderer process by that process's recent
 * failed-connect count (`WebSocketPerProcessThrottler`: delay =
 * rand(1..5s) * 2^min(pending + failed/(succeeded+1), 16) / 65536). One dead
 * federated hub failing ~12×/min pushed that to the cap, so the DEFAULT hub's
 * socket on a renderer reload sat 2.4s in the throttle before its handshake
 * (measured: WebSocketCreate 1.096s → SendHandshakeRequest 3.518s), and the
 * whole boot (tabStore → React mount) waited on it.
 *
 * The failures did not come from @trpc/client's reconnect loop (that one backs
 * off 0, 2, 4, …, 30s) but from `batchSend` → `open()`: EVERY operation issued
 * while the socket is down opens a fresh socket, outside the backoff.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import type { TRPCClient } from '@trpc/client'
import { initTRPC } from '@trpc/server'
import { createTrpcWsClient, type RuntimeClient } from './runtime'
import { setHubConnectProbe } from './connectPacing'

// The one procedure these tests call, at the app's path. Only the type is used: the
// wire is path-based and no server ever answers here.
const t = initTRPC.create()
const testRouter = t.router({
  settings: t.router({
    get: t.procedure.input((v) => v as { key: string }).query(() => null)
  })
})
const asTestClient = (client: RuntimeClient) => client as unknown as TRPCClient<typeof testRouter>

async function deadPort(): Promise<number> {
  return await new Promise<number>((resolve) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      server.close(() => resolve(port))
    })
  })
}

const RealWebSocket = globalThis.WebSocket
let constructed = 0
class CountingWebSocket extends RealWebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols)
    constructed++
  }
}

const closers: Array<() => void> = []
afterEach(() => {
  while (closers.length) closers.pop()?.()
  setHubConnectProbe(null)
  vi.unstubAllGlobals()
  constructed = 0
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Fire `n` queries spaced `gapMs` apart; each one, today, opens its own socket. */
async function fireQueries(client: RuntimeClient, n: number, gapMs: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    void asTestClient(client)
      .settings.get.query({ key: `k${i}` })
      .catch(() => null)
    await sleep(gapMs)
  }
}

describe('connect pacing for an unreachable hub', () => {
  it('with a probe that says "down", queries do not open sockets outside the backoff schedule', async () => {
    vi.stubGlobal('WebSocket', CountingWebSocket)
    const probe = vi.fn(async () => false)
    setHubConnectProbe(probe)
    const port = await deadPort()
    const { client, wsClient } = createTrpcWsClient({
      url: `ws://127.0.0.1:${port}/trpc`,
      connectDeadlineMs: 60_000
    })
    closers.push(() => void wsClient.close())

    await fireQueries(client, 10, 120)

    // Backoff schedule within ~1.2s: the constructor's attempt + the loop's
    // attempt at 0ms (the next one is due at 2s). Nothing per query.
    expect(constructed).toBeLessThanOrEqual(2)
    // The out-of-schedule attempts asked the probe instead of the network.
    expect(probe).toHaveBeenCalled()
  })

  it('with a probe that says "up", a query reconnects immediately (no wait for the backoff)', async () => {
    vi.stubGlobal('WebSocket', CountingWebSocket)
    const port = await deadPort()
    let serverUp = false
    setHubConnectProbe(async () => serverUp)
    const { client, wsClient } = createTrpcWsClient({
      url: `ws://127.0.0.1:${port}/trpc`,
      connectDeadlineMs: 60_000
    })
    closers.push(() => void wsClient.close())
    // Let the constructor attempt + the 0ms loop attempt fail; the next loop
    // attempt is now ~2s out.
    await sleep(300)

    const wss = new WebSocketServer({ host: '127.0.0.1', port })
    closers.push(() => wss.close())
    await new Promise<void>((r) => wss.once('listening', () => r()))
    serverUp = true

    const t0 = Date.now()
    void asTestClient(client)
      .settings.get.query({ key: 'x' })
      .catch(() => null)
    await new Promise<void>((resolve) => {
      const sub = wsClient.connectionState.subscribe({
        next: (s) => {
          if (s.state === 'pending') {
            sub.unsubscribe()
            resolve()
          }
        }
      })
    })
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  it('without a probe (fork, web shell), behaviour is unchanged: each query may open a socket', async () => {
    vi.stubGlobal('WebSocket', CountingWebSocket)
    const port = await deadPort()
    const { client, wsClient } = createTrpcWsClient({
      url: `ws://127.0.0.1:${port}/trpc`,
      connectDeadlineMs: 60_000
    })
    closers.push(() => void wsClient.close())

    await fireQueries(client, 6, 120)

    expect(constructed).toBeGreaterThan(4)
  })

  it('the first connect is never probed (boot path byte-identical)', async () => {
    vi.stubGlobal('WebSocket', CountingWebSocket)
    const probe = vi.fn(async () => true)
    setHubConnectProbe(probe)
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    closers.push(() => wss.close())
    await new Promise<void>((r) => wss.once('listening', () => r()))
    const port = (wss.address() as AddressInfo).port
    const { wsClient } = createTrpcWsClient({ url: `ws://127.0.0.1:${port}/trpc` })
    closers.push(() => void wsClient.close())
    await new Promise<void>((resolve) => {
      const sub = wsClient.connectionState.subscribe({
        next: (s) => {
          if (s.state === 'pending') {
            sub.unsubscribe()
            resolve()
          }
        }
      })
    })
    expect(probe).not.toHaveBeenCalled()
    expect(constructed).toBe(1)
  })
})
