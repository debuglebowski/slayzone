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
 *
 * Two layers, neither depends on wall-clock timing:
 * - The pacer's schedule decisions, driven step by step with an injected clock
 *   and probe (`createConnectPacer(url, { now, probe })`).
 * - One real tRPC client against one real ws server (bound once; the test
 *   decides whether it accepts handshakes), under fake `setTimeout` + `Date`, so
 *   the reconnect loop only runs when the test advances the clock. Every wait is
 *   on an event (connection state, the loop asking for its next delay).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import type { TRPCClient } from '@trpc/client'
import { initTRPC } from '@trpc/server'
import { createTrpcWsClient } from './runtime'
import {
  createConnectPacer,
  exponentialBackoff,
  HubConnectDeferredError,
  type HubConnectProbe,
  setHubConnectProbe
} from './connectPacing'

// Observe (never alter) the loop's "how long until the next attempt?" question:
// the real client's pacer is the real one, its retryDelayMs calls reported here.
const retryDelayListeners = new Set<(attemptIndex: number) => void>()
vi.mock('./connectPacing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./connectPacing')>()
  return {
    ...actual,
    createConnectPacer: (...args: Parameters<typeof actual.createConnectPacer>) => {
      const pacer = actual.createConnectPacer(...args)
      return {
        ...pacer,
        retryDelayMs: (attemptIndex: number) => {
          const delay = pacer.retryDelayMs(attemptIndex)
          for (const l of retryDelayListeners) l(attemptIndex)
          return delay
        }
      }
    }
  }
})

const WS_URL = 'ws://hub.test/trpc'

afterEach(() => {
  setHubConnectProbe(null)
  retryDelayListeners.clear()
})

/**
 * A pacer on a test clock, walked through what the reconnect loop does for a
 * hub that is down: the constructor's attempt fails, the loop's 0ms attempt
 * fails, the loop now sleeps until `t0 + 2000`.
 */
async function pacerInFailureStreak(probe: HubConnectProbe | null) {
  let t = 10_000
  const pacer = createConnectPacer(WS_URL, { now: () => t, probe: () => probe })
  const clock = { set: (ms: number) => void (t = ms), get: () => t }
  // Constructor attempt: never probed, fails before opening.
  expect(await pacer.url()).toBe(WS_URL)
  pacer.onCloseOrError()
  // Loop attempt 0 is due immediately and is on schedule.
  expect(pacer.retryDelayMs(0)).toBe(0)
  expect(await pacer.url()).toBe(WS_URL)
  pacer.onCloseOrError()
  // Loop attempt 1 is due 2s out.
  expect(pacer.retryDelayMs(1)).toBe(2000)
  return { pacer, clock, t0: 10_000 }
}

describe('connect pacing for an unreachable hub', () => {
  it('with a probe that says "down", queries do not open sockets outside the backoff schedule', async () => {
    const probe = vi.fn(async (_url: string) => false)
    const { pacer, clock, t0 } = await pacerInFailureStreak(probe)
    expect(probe).not.toHaveBeenCalled()

    // Ten queries between the loop's attempts: each asks the probe, none gets a url
    // (no url → no socket is constructed).
    for (let i = 1; i <= 10; i++) {
      clock.set(t0 + i * 120)
      await expect(pacer.url()).rejects.toBeInstanceOf(HubConnectDeferredError)
    }
    expect(probe).toHaveBeenCalledTimes(10)
    expect(probe).toHaveBeenCalledWith(WS_URL)

    // A probe that throws counts as down.
    const throwing = await pacerInFailureStreak(async () => {
      throw new Error('probe broke')
    })
    throwing.clock.set(throwing.t0 + 500)
    await expect(throwing.pacer.url()).rejects.toBeInstanceOf(HubConnectDeferredError)

    // The loop's own attempt (its timer may fire up to 50ms early) is never probed.
    clock.set(t0 + 2000 - 50)
    expect(await pacer.url()).toBe(WS_URL)
    clock.set(t0 + 2000)
    expect(await pacer.url()).toBe(WS_URL)
    expect(probe).toHaveBeenCalledTimes(10)
  })

  it('with a probe that says "up", a query reconnects immediately (no wait for the backoff)', async () => {
    let up = false
    const probe = vi.fn(async (_url: string) => up)
    const { pacer, clock, t0 } = await pacerInFailureStreak(probe)

    clock.set(t0 + 300)
    await expect(pacer.url()).rejects.toBeInstanceOf(HubConnectDeferredError)

    // The hub came back: the very next query gets the url at t0+300, 1.7s before
    // the loop's attempt would have been allowed.
    up = true
    expect(await pacer.url()).toBe(WS_URL)
    expect(clock.get()).toBe(t0 + 300)
    expect(probe).toHaveBeenCalledTimes(2)

    // Once a socket opened the streak is over: no more probing.
    pacer.onOpen()
    up = false
    expect(await pacer.url()).toBe(WS_URL)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('without a probe (fork, web shell), behaviour is unchanged: each query may open a socket', async () => {
    const { pacer, clock, t0 } = await pacerInFailureStreak(null)
    for (let i = 1; i <= 6; i++) {
      clock.set(t0 + i * 120)
      expect(await pacer.url()).toBe(WS_URL)
      pacer.onCloseOrError()
    }
    // The loop's delays are @trpc/client's defaults.
    const fresh = createConnectPacer(WS_URL, { now: () => 0, probe: () => null })
    const delays = [0, 1, 2, 3, 4, 5, 6].map((i) => fresh.retryDelayMs(i))
    expect(delays).toEqual([0, 2000, 4000, 8000, 16_000, 30_000, 30_000])
    expect(delays).toEqual([0, 1, 2, 3, 4, 5, 6].map(exponentialBackoff))
  })

  it('the first connect is never probed (boot path byte-identical)', async () => {
    const probe = vi.fn(async (_url: string) => false)
    let t = 0
    const pacer = createConnectPacer(WS_URL, { now: () => t, probe: () => probe })
    expect(await pacer.url()).toBe(WS_URL)
    // Nor is the first reconnect after a socket that had opened drops, even
    // off-schedule: the hub was just reachable.
    pacer.onOpen()
    pacer.onCloseOrError()
    pacer.retryDelayMs(1)
    t = 100
    expect(await pacer.url()).toBe(WS_URL)
    expect(probe).not.toHaveBeenCalled()

    // The default deps read the process-wide probe per attempt.
    const viaGlobal = createConnectPacer(WS_URL)
    expect(await viaGlobal.url()).toBe(WS_URL)
    viaGlobal.onCloseOrError()
    viaGlobal.retryDelayMs(1)
    setHubConnectProbe(probe)
    await expect(viaGlobal.url()).rejects.toBeInstanceOf(HubConnectDeferredError)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('a real client: first connect unprobed, probe "down" opens no socket, probe "up" reconnects before the next backoff tick', async () => {
    let accepting = false
    let handshakes = 0
    const wss = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      verifyClient: (_info, done) => {
        handshakes++
        done(accepting, 503)
      }
    })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/trpc`

    const RealWebSocket = globalThis.WebSocket
    let constructed = 0
    class CountingWebSocket extends RealWebSocket {
      constructor(u: string | URL, protocols?: string | string[]) {
        super(u, protocols)
        constructed++
      }
    }
    vi.stubGlobal('WebSocket', CountingWebSocket)

    let up = false
    const probe = vi.fn(async (_url: string) => up)
    setHubConnectProbe(probe)
    const nextRetryDelay = (attemptIndex: number) =>
      new Promise<void>((resolve) => {
        const l = (i: number) => {
          if (i !== attemptIndex) return
          retryDelayListeners.delete(l)
          resolve()
        }
        retryDelayListeners.add(l)
      })

    // Only the reconnect loop's sleeps and the pacer's clock are faked; sockets are real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    let wsClient: ReturnType<typeof createTrpcWsClient>['wsClient'] | null = null
    try {
      // Constructor attempt: rejected by the hub. Wait for its open() to settle (it
      // reports "Initialization error") — the loop's first attempt must not join it.
      const firstRetry = nextRetryDelay(0)
      const created = createTrpcWsClient({ url, connectDeadlineMs: 60_000 })
      wsClient = created.wsClient
      const client = created.client as unknown as TRPCClient<typeof testRouter>
      await nextState(wsClient, isInitError)
      await firstRetry
      expect(probe).not.toHaveBeenCalled()

      // Loop attempt 0 (due at 0ms): on schedule, also rejected; attempt 1 is 2s out.
      const secondRetry = nextRetryDelay(1)
      vi.advanceTimersByTime(0)
      await secondRetry
      expect({ constructed, handshakes }).toEqual({ constructed: 2, handshakes: 2 })
      expect(probe).not.toHaveBeenCalled()

      // A query while down: the probe declines, so no socket is created.
      const deferred = nextState(wsClient, isInitError)
      void client.settings.get.query({ key: 'a' }).catch(() => null)
      const declined = await deferred
      expect(String(declined.error?.cause?.cause)).toContain('HubConnectDeferredError')
      expect(probe).toHaveBeenCalledTimes(1)
      expect({ constructed, handshakes }).toEqual({ constructed: 2, handshakes: 2 })

      // The hub is back. The next query reconnects now; the loop's 2s timer has
      // not fired (fake clock never advanced), so this was not the backoff.
      accepting = true
      up = true
      const opened = nextState(wsClient, (s) => s.state === 'pending')
      void client.settings.get.query({ key: 'b' }).catch(() => null)
      await opened
      expect(probe).toHaveBeenCalledTimes(2)
      expect({ constructed, handshakes }).toEqual({ constructed: 3, handshakes: 3 })
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
      if (wsClient) await wsClient.close()
      await new Promise<void>((r) => wss.close(() => r()))
    }
  })
})

// The one procedure the real client calls, at the app's path. Only the type is
// used: the wire is path-based and the test server never answers it.
const t = initTRPC.create()
const testRouter = t.router({
  settings: t.router({
    get: t.procedure.input((v) => v as { key: string }).query(() => null)
  })
})

type ConnState = ReturnType<
  ReturnType<typeof createTrpcWsClient>['wsClient']['connectionState']['get']
>

/** A failed `open()` (constructor or query-triggered), as the client reports it. */
const isInitError = (s: ConnState): boolean =>
  s.state === 'connecting' && s.error?.message === 'Initialization error'

/** The next connection-state event matching `match` (the current state is skipped). */
function nextState(
  wsClient: ReturnType<typeof createTrpcWsClient>['wsClient'],
  match: (s: ConnState) => boolean
): Promise<ConnState> {
  return new Promise((resolve) => {
    let skippedCurrent = false
    let done = false
    const sub = wsClient.connectionState.subscribe({
      next: (s) => {
        // behaviorSubject replays the current value synchronously on subscribe.
        if (!skippedCurrent || done || !match(s)) return
        done = true
        queueMicrotask(() => sub.unsubscribe())
        resolve(s)
      }
    })
    skippedCurrent = true
  })
}
