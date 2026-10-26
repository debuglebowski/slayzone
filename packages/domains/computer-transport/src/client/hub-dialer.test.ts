/**
 * Dialer-focused loopback tests: reconnect backoff, dialer-side heartbeat
 * loss, malformed hub frames, and wss certificate verification (CA chain +
 * hostname, no pin).
 */
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import {
  createTestCa,
  trustTestCaInThisProcess,
  type TestCa,
  type TestLeaf
} from '@slayzone/test-utils/test-ca'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { COMPUTER_PROTOCOL_VERSION, ComputerTransportErrorCodes } from '../shared/frames'
import { startLoopbackHub, type LoopbackHub } from '../testing/loopback'
import { createMemoryCredentialStore } from './credential-store'
import { HubDialer, type HubDialerOptions } from './hub-dialer'

const IDENTITY = {
  name: 'test-computer',
  platform: 'darwin-arm64',
  version: '0.0.0',
  capabilities: ['pty']
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  vi.useRealTimers()
})

function makeDialer(url: string, overrides: Partial<HubDialerOptions> = {}): HubDialer {
  const dialer = new HubDialer({
    url,
    identity: IDENTITY,
    credentialStore: createMemoryCredentialStore(),
    joinToken: 'jt-valid',
    heartbeatIntervalMs: 0,
    backoff: { initialDelayMs: 100, maxDelayMs: 1_000, multiplier: 2, jitterRatio: 0 },
    ...overrides
  })
  cleanups.push(() => dialer.stop())
  return dialer
}

async function startHub(...args: Parameters<typeof startLoopbackHub>): Promise<LoopbackHub> {
  const hub = await startLoopbackHub(...args)
  cleanups.push(() => hub.close())
  return hub
}

describe('reconnect with backoff', () => {
  it('schedules exponential retries after connection loss and recovers via hello', async () => {
    vi.useFakeTimers()
    const store = createMemoryCredentialStore()
    const hub = await startHub()
    const port = hub.port

    const dialer = makeDialer(hub.url, { credentialStore: store })
    dialer.start()
    await dialer.events.once('connected')

    // Kill the hub: dialer must schedule retry #1 at the initial delay.
    const retry1Promise = dialer.events.once('reconnect-scheduled')
    await hub.close() // idempotent — the registered cleanup close is a no-op
    const retry1 = await retry1Promise
    expect(retry1).toEqual({ attempt: 1, delayMs: 100 })
    expect(dialer.state).toBe('waiting-retry')

    // Advance to just before the delay: no reconnect attempt yet.
    let connecting = false
    dialer.events.on('state-change', ({ state }) => {
      if (state === 'connecting') connecting = true
    })
    await vi.advanceTimersByTimeAsync(99)
    expect(connecting).toBe(false)

    // Cross the boundary: attempt fires, fails (port closed), retry #2 doubles.
    const retry2Promise = dialer.events.once('reconnect-scheduled')
    await vi.advanceTimersByTimeAsync(1)
    expect(connecting).toBe(true)
    const retry2 = await retry2Promise
    expect(retry2).toEqual({ attempt: 2, delayMs: 200 })

    // One more failure: delay doubles again.
    const retry3Promise = dialer.events.once('reconnect-scheduled')
    await vi.advanceTimersByTimeAsync(200)
    const retry3 = await retry3Promise
    expect(retry3).toEqual({ attempt: 3, delayMs: 400 })

    // Bring the hub back on the SAME port: next retry reconnects via hello
    // with the credentials persisted at enrollment.
    const revived = await startLoopbackHub({}, { port })
    cleanups.push(() => revived.close())
    // Share the auth backend state: revived hub must recognize the old key.
    const saved = await store.load()
    revived.auth.byApiKey.set(saved!.apiKey, {
      computerId: saved!.computerId,
      name: IDENTITY.name,
      platform: IDENTITY.platform,
      version: IDENTITY.version,
      capabilities: IDENTITY.capabilities
    })

    const reconnected = dialer.events.once('connected')
    await vi.advanceTimersByTimeAsync(400)
    const connected = await reconnected
    expect(connected.mode).toBe('hello')
    expect(connected.computerId).toBe(saved!.computerId)
    // Backoff attempt counter resets after a successful connection.
    const retryAfterSuccessPromise = dialer.events.once('reconnect-scheduled')
    await revived.close()
    const retryAfterSuccess = await retryAfterSuccessPromise
    expect(retryAfterSuccess).toEqual({ attempt: 1, delayMs: 100 })
  })

  it('stop() cancels a pending retry', async () => {
    vi.useFakeTimers()
    const hub = await startHub()
    const dialer = makeDialer(hub.url)
    dialer.start()
    await dialer.events.once('connected')
    const retryScheduled = dialer.events.once('reconnect-scheduled')
    await hub.close()
    await retryScheduled
    await dialer.stop()
    expect(dialer.state).toBe('stopped')
    let connecting = false
    dialer.events.on('state-change', ({ state }) => {
      if (state === 'connecting') connecting = true
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(connecting).toBe(false)
  })
})

describe('heartbeat-loss detection (computer side)', () => {
  it('tears the socket down and reconnects when the hub stops answering heartbeats', async () => {
    vi.useFakeTimers()
    // Raw ws server that authenticates but swallows heartbeats.
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve) => wss.once('listening', resolve))
    cleanups.push(() => new Promise<void>((resolve) => wss.close(() => resolve())))
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const frame = JSON.parse(data.toString()) as { id?: number; method?: string }
        if (frame.method === 'enroll' || frame.method === 'hello') {
          ws.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: frame.id,
              result:
                frame.method === 'enroll'
                  ? {
                      computerId: 'computer-1',
                      apiKey: 'key-1',
                      protocolVersion: COMPUTER_PROTOCOL_VERSION
                    }
                  : { computerId: 'computer-1', protocolVersion: COMPUTER_PROTOCOL_VERSION }
            })
          )
        }
        // heartbeat: swallowed on purpose
      })
    })
    const port = (wss.address() as AddressInfo).port

    const dialer = makeDialer(`ws://127.0.0.1:${port}`, {
      heartbeatIntervalMs: 1_000,
      heartbeatTimeoutMs: 500
    })
    dialer.start()
    await dialer.events.once('connected')

    const disconnected = dialer.events.once('disconnected')
    const retryScheduled = dialer.events.once('reconnect-scheduled')
    await vi.advanceTimersByTimeAsync(1_000) // heartbeat sent
    await vi.advanceTimersByTimeAsync(500) // heartbeat times out → terminate
    await disconnected
    expect((await retryScheduled).attempt).toBe(1)
  })
})

describe('computer protocol v3 (T-27)', () => {
  /** Raw hub: answers enroll/hello with `authResult`, then runs `afterAuth`. */
  async function rawHub(
    authResult: (frame: Record<string, unknown>) => Record<string, unknown>,
    afterAuth?: (ws: import('ws').WebSocket) => void
  ): Promise<number> {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve) => wss.once('listening', resolve))
    cleanups.push(() => new Promise<void>((resolve) => wss.close(() => resolve())))
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>
        if (frame.method === 'enroll' || frame.method === 'hello') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, ...authResult(frame) }))
          afterAuth?.(ws)
        }
      })
    })
    return (wss.address() as AddressInfo).port
  }

  it('refuses, fatally and clearly, a hub that does not echo protocol v3 (an older hub)', async () => {
    const port = await rawHub(() => ({ result: { computerId: 'c-1', apiKey: 'k-1' } }))
    const dialer = makeDialer(`ws://127.0.0.1:${port}`)
    const connected = vi.fn()
    dialer.events.on('connected', connected)
    dialer.start()
    const { error, fatal } = await dialer.events.once('error')
    expect(fatal).toBe(true)
    expect(error.message).toMatch(/older than v3.*upgrade the hub/)
    expect(connected).not.toHaveBeenCalled()
  })

  it('a hub refusing the reconnect over the protocol is fatal, not retried forever', async () => {
    const port = await rawHub(() => ({
      error: { code: ComputerTransportErrorCodes.protocolMismatch, message: 'hub speaks v4' }
    }))
    const store = createMemoryCredentialStore({ computerId: 'c-1', apiKey: 'k-1' })
    const dialer = makeDialer(`ws://127.0.0.1:${port}`, { credentialStore: store })
    dialer.start()
    const { error, fatal } = await dialer.events.once('error')
    expect(fatal).toBe(true)
    expect(error.message).toMatch(/hub refused reconnect: hub speaks v4/)
  })

  it('sends protocolVersion on hello, and hands the request envelope actor to onHubRequest', async () => {
    const seenHello: Record<string, unknown>[] = []
    const reply = new Promise<Record<string, unknown>>((resolve) => {
      void rawHub(
        (hello) => {
          seenHello.push(hello)
          return { result: { computerId: 'c-1', protocolVersion: COMPUTER_PROTOCOL_VERSION } }
        },
        (ws) => {
          ws.on('message', (data) => {
            const frame = JSON.parse(data.toString()) as Record<string, unknown>
            if (frame.id === 'h-1') resolve(frame)
          })
          ws.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 'h-1',
              method: 'git.isGitRepo',
              params: { path: '/x' },
              actor: { userId: 'u-1', route: 'trpc t' }
            })
          )
        }
      ).then((port) => {
        const store = createMemoryCredentialStore({ computerId: 'c-1', apiKey: 'k-1' })
        const dialer = makeDialer(`ws://127.0.0.1:${port}`, {
          credentialStore: store,
          onHubRequest: (method, params, actor) => ({ method, params, actor })
        })
        dialer.start()
      })
    })
    const frame = await reply
    expect(frame.result).toEqual({
      method: 'git.isGitRepo',
      params: { path: '/x' },
      actor: { userId: 'u-1', route: 'trpc t' }
    })
    expect((seenHello[0].params as Record<string, unknown>).protocolVersion).toBe(
      COMPUTER_PROTOCOL_VERSION
    )
  })
})

describe('malformed frames from the hub', () => {
  it('survives garbage frames and keeps the session alive', async () => {
    const hub = await startHub()
    const parseErrors: string[] = []
    const dialer = makeDialer(hub.url, {
      log: (message) => {
        if (message.includes('malformed')) parseErrors.push(message)
      }
    })
    dialer.start()
    await dialer.events.once('connected')

    // Reach under the hood: send garbage straight down the hub's socket.
    for (const client of hub.wss.clients) client.send('garbage{')
    await vi.waitFor(() => expect(parseErrors.length).toBeGreaterThanOrEqual(1))

    // Session is still healthy: a hub request round-trips.
    const pong = await hub.gateway.request<{ ts: number }>(dialer.computerId!, 'ping')
    expect(typeof pong.ts).toBe('number')
    expect(dialer.state).toBe('connected')
  })
})

describe('wss certificate verification (CA chain + hostname, no pin)', () => {
  // The hub's front end presents a CA-issued certificate; the dialer verifies it with
  // Node's defaults. The test CA is trusted the normal way — added to this process's
  // default CA store — never through an option on the dialer.
  let ca: TestCa
  let restoreCa: (() => void) | null = null
  beforeAll(() => {
    ca = createTestCa()
  })
  afterAll(() => ca.cleanup())
  afterEach(() => {
    restoreCa?.()
    restoreCa = null
  })

  async function startTlsHub(leaf: TestLeaf): Promise<{ hub: LoopbackHub; port: number }> {
    const https = createHttpsServer({ cert: leaf.certPem, key: leaf.keyPem })
    await new Promise<void>((resolve) => https.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => https.close(() => resolve())))
    const hub = await startLoopbackHub({}, { server: https })
    cleanups.push(() => hub.close())
    return { hub, port: (https.address() as AddressInfo).port }
  }

  it('connects to a hub whose certificate chains to a trusted CA', async () => {
    restoreCa = trustTestCaInThisProcess(ca.caPem)
    const { hub, port } = await startTlsHub(ca.issueLeaf())
    const dialer = makeDialer(`wss://localhost:${port}`)
    dialer.start()
    const connected = await dialer.events.once('connected')
    expect(connected.mode).toBe('enroll')
    expect(hub.gateway.listComputers()).toHaveLength(1)
  })

  it('refuses a certificate no trusted CA issued, before sending any computer frame', async () => {
    // Same leaf shape, but its CA is not trusted: no pin, no override can rescue it.
    const { hub, port } = await startTlsHub(ca.issueLeaf())
    const dialer = makeDialer(`wss://localhost:${port}`)
    const errorEvent = dialer.events.once('error')
    let connected = false
    dialer.events.on('connected', () => {
      connected = true
    })
    dialer.start()
    const { error } = await errorEvent
    expect(error.message).toMatch(/certificate/i)
    expect(connected).toBe(false)
    expect(hub.gateway.listComputers()).toHaveLength(0)
    await dialer.stop()
  })

  it('refuses a trusted certificate issued for a different host name', async () => {
    restoreCa = trustTestCaInThisProcess(ca.caPem)
    const { hub, port } = await startTlsHub(ca.issueLeaf({ dnsNames: ['other.example'], ips: [] }))
    const dialer = makeDialer(`wss://localhost:${port}`)
    const errorEvent = dialer.events.once('error')
    dialer.start()
    const { error } = await errorEvent
    expect(error.message).toMatch(/altnames|does not match/i)
    expect(hub.gateway.listComputers()).toHaveLength(0)
    await dialer.stop()
  })
})
