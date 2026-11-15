/** Deterministic event orderings against the installed CJS and ESM tRPC clients. */
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTRPCClient, createWSClient, wsLink, type TRPCClient } from '@trpc/client'
import { initTRPC } from '@trpc/server'
import { wireSuperjson } from '@slayzone/trpc-server/wire'
import { connectDeadlineLink } from './connectDeadlineLink'
import { setHubConnectProbe } from './connectPacing'
import { createTrpcWsClient } from './runtime'

const require = createRequire(import.meta.url)
const cjs: typeof import('@trpc/client') = require('@trpc/client')
const t = initTRPC.create({ transformer: wireSuperjson })
const router = t.router({
  ping: t.procedure.query(() => 'pong'),
  slow: t.procedure.query(() => 'slow'),
  ticks: t.procedure.subscription(async function* () {
    yield 1
  })
})

interface Message {
  id: number
  method: string
  params?: { path: string; lastEventId?: string }
}

/** Only network delivery is controlled; client, retry loop, wire and deadlines are real. */
function network() {
  let accepting = true
  let heldUpgrades = 0
  let holdClose = false
  const sockets: TestSocket[] = []
  class TestSocket extends EventTarget {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3
    readyState = 0
    sent: Message[] = []
    constructor(_url: string | URL) {
      super()
      sockets.push(this)
      setTimeout(() => {
        if (!accepting) {
          this.readyState = 3
          this.dispatchEvent(new Event('error'))
          this.deliverClose()
        } else if (heldUpgrades > 0) heldUpgrades--
        else {
          this.readyState = 1
          this.dispatchEvent(new Event('open'))
        }
      }, 0)
    }
    deliverClose() {
      this.dispatchEvent(new Event('close'))
    }
    close() {
      if (this.readyState === 3) return
      const connecting = this.readyState === 0
      this.readyState = 3
      if (connecting) this.dispatchEvent(new Event('error'))
      if (!holdClose) this.deliverClose()
    }
    receive(value: unknown) {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }))
    }
    send(data: string) {
      if (this.readyState !== 1) throw new Error('Socket is not open')
      const decoded: Message | Message[] = JSON.parse(data)
      for (const message of Array.isArray(decoded) ? decoded : [decoded]) {
        this.sent.push(message)
        if (message.method === 'subscription.stop') continue
        const subscription = message.method === 'subscription'
        setTimeout(
          () => {
            if (this.readyState !== 1) return
            this.receive({
              id: message.id,
              result: {
                ...(subscription ? { type: 'data', id: `event-${sockets.indexOf(this)}` } : {}),
                data: wireSuperjson.serialize(
                  subscription
                    ? sockets.indexOf(this)
                    : message.params?.path === 'slow'
                      ? 'slow'
                      : 'pong'
                )
              }
            })
          },
          message.params?.path === 'slow' ? 2000 : 0
        )
      }
    }
  }
  return {
    sockets,
    WebSocket: TestSocket as unknown as typeof WebSocket,
    accept: (value: boolean) => {
      accepting = value
    },
    holdUpgrade: () => {
      heldUpgrades++
    },
    holdClose: () => {
      holdClose = true
    }
  }
}

const clients: Array<{ close: () => Promise<void> }> = []
const advance = (ms = 10) => vi.advanceTimersByTimeAsync(ms)

afterEach(async () => {
  for (const client of clients.splice(0)) {
    const closed = client.close()
    await advance()
    await closed
  }
  setHubConnectProbe(null)
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('one query during established 16s backoff recovers after a held handshake, with default deadlines', async () => {
  vi.useFakeTimers()
  const net = network()
  vi.stubGlobal('WebSocket', net.WebSocket)
  let up = false
  setHubConnectProbe(async () => up)
  net.accept(false)
  const { client: runtimeClient, wsClient } = createTrpcWsClient({
    url: 'ws://127.0.0.1:12345/trpc'
  })
  const client = runtimeClient as unknown as TRPCClient<typeof router>
  clients.push(wsClient)
  // Initial + loop attempts at 0, 2, 6, 14s. The loop is now sleeping until 30s.
  await advance(14_500)
  expect(net.sockets).toHaveLength(5)
  net.accept(true)
  up = true
  net.holdUpgrade()
  let result: unknown
  // Exactly ONE operation. No polling query supplies a replacement open().
  void client.ping.query().then(
    (value) => {
      result = value
    },
    (error: unknown) => {
      result = error
    }
  )
  await advance(1100)
  expect(result).toBe('pong')
  expect(net.sockets).toHaveLength(7)
  expect(wsClient.connectionState.get().state).toBe('pending')
})

describe.each([
  ['ESM', { createTRPCClient, createWSClient, wsLink }],
  ['CJS', cjs]
] as const)('%s installed reconnect loop', (_format, trpc) => {
  async function setup() {
    vi.useFakeTimers()
    const net = network()
    const ws = trpc.createWSClient({
      url: 'ws://hub.test/trpc',
      WebSocket: net.WebSocket,
      retryDelayMs: (attempt) => (attempt === 0 ? 0 : 1000)
    })
    clients.push(ws)
    const client = trpc.createTRPCClient<typeof router>({
      links: [
        connectDeadlineLink({ connectionState: ws.connectionState, deadlineMs: 500 }),
        trpc.wsLink({ client: ws, transformer: wireSuperjson })
      ]
    })
    const seen: number[] = []
    const sub = client.ticks.subscribe(undefined, { onData: (value) => seen.push(value) })
    const first = client.ping.query()
    await advance()
    await expect(first).resolves.toBe('pong')
    const original = net.sockets[0]
    net.holdClose()
    net.accept(false)
    original.receive({ id: null, method: 'reconnect' })
    await advance()
    expect(net.sockets).toHaveLength(2)
    net.accept(true)
    const recovered = client.ping.query()
    await advance()
    await expect(recovered).resolves.toBe('pong')
    expect(net.sockets).toHaveLength(3)
    expect(seen).toEqual([0, 2])
    return { net, ws, client, original, seen, sub }
  }

  it('honors a newer server reconnect on the current socket, then replays once with coherent state', async () => {
    const { net, ws, client, seen, sub } = await setup()
    try {
      net.sockets[2].receive({ id: null, method: 'reconnect' })
      await advance(1100)
      expect(net.sockets).toHaveLength(4)
      expect(ws.connectionState.get().state).toBe('pending')
      const latest = net.sockets[3].sent.filter((m) => m.method === 'subscription')
      expect(latest).toHaveLength(1)
      expect(latest[0].params?.lastEventId).toBe('event-2')
      expect(seen).toEqual([0, 2, 3])
      const slow = client.slow.query()
      await advance(2100)
      await expect(slow).resolves.toBe('slow')
    } finally {
      sub.unsubscribe()
    }
  })

  it('ignores old close/error/message/open callbacks while a slow call and replay use the replacement', async () => {
    const { net, ws, client, original, seen, sub } = await setup()
    const states: string[] = []
    const observer = ws.connectionState.subscribe({ next: (value) => states.push(value.state) })
    try {
      const slow = client.slow.query().then(
        (value) => value,
        (error: unknown) => error
      )
      await advance()
      // Deliver the old socket's events only AFTER the replacement has sent work.
      original.deliverClose()
      original.dispatchEvent(new Event('error'))
      const subscription = original.sent.find((m) => m.method === 'subscription')!
      original.receive({
        id: subscription.id,
        result: { type: 'data', id: 'stale', data: wireSuperjson.serialize(-1) }
      })
      original.receive({ id: null, method: 'reconnect' })
      original.dispatchEvent(new Event('open'))
      await advance(2100)
      await expect(slow).resolves.toBe('slow')
      expect(ws.connectionState.get().state).toBe('pending')
      expect(states).toEqual(['pending'])
      expect(net.sockets).toHaveLength(3)
      expect(seen).toEqual([0, 2])
      expect(net.sockets[2].sent.filter((m) => m.method === 'subscription')).toHaveLength(1)
    } finally {
      observer.unsubscribe()
      sub.unsubscribe()
    }
  })
})
