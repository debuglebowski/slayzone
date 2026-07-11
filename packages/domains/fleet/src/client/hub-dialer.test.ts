/**
 * Dialer-focused loopback tests: reconnect backoff, dialer-side heartbeat
 * loss, malformed hub frames, and wss certificate pinning.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { certSha256Fingerprint } from '../shared/pinning'
import { startLoopbackHub, type LoopbackHub } from '../testing/loopback'
import { createMemoryCredentialStore } from './credential-store'
import { HubDialer, type HubDialerOptions } from './hub-dialer'

const IDENTITY = { name: 'test-runner', platform: 'darwin-arm64', version: '0.0.0', capabilities: ['pty'] }

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
      runnerId: saved!.runnerId,
      name: IDENTITY.name,
      platform: IDENTITY.platform,
      version: IDENTITY.version,
      capabilities: IDENTITY.capabilities
    })

    const reconnected = dialer.events.once('connected')
    await vi.advanceTimersByTimeAsync(400)
    const connected = await reconnected
    expect(connected.mode).toBe('hello')
    expect(connected.runnerId).toBe(saved!.runnerId)
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

describe('heartbeat-loss detection (runner side)', () => {
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
                frame.method === 'enroll' ? { runnerId: 'runner-1', apiKey: 'key-1' } : { runnerId: 'runner-1' }
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
    const pong = await hub.gateway.request<{ ts: number }>(dialer.runnerId!, 'ping')
    expect(typeof pong.ts).toBe('number')
    expect(dialer.state).toBe('connected')
  })
})

describe('wss certificate pinning', () => {
  function generateCert(dir: string): { certPem: string; keyPem: string } {
    const keyPath = join(dir, 'key.pem')
    const certPath = join(dir, 'cert.pem')
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost'],
      { stdio: 'pipe' }
    )
    return { certPem: readFileSync(certPath, 'utf8'), keyPem: readFileSync(keyPath, 'utf8') }
  }

  async function startTlsHub(): Promise<{ hub: LoopbackHub; https: HttpsServer; url: string; fingerprint: string }> {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-tls-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const { certPem, keyPem } = generateCert(dir)
    const https = createHttpsServer({ cert: certPem, key: keyPem })
    await new Promise<void>((resolve) => https.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => https.close(() => resolve())))
    const hub = await startLoopbackHub({}, { server: https })
    cleanups.push(() => hub.close())
    const port = (https.address() as AddressInfo).port
    return { hub, https, url: `wss://127.0.0.1:${port}`, fingerprint: certSha256Fingerprint(certPem) }
  }

  it('connects to a self-signed hub when the pin matches', async () => {
    const { hub, url, fingerprint } = await startTlsHub()
    const dialer = makeDialer(url, { pinnedCertSha256: fingerprint })
    dialer.start()
    const connected = await dialer.events.once('connected')
    expect(connected.mode).toBe('enroll')
    expect(hub.gateway.listRunners()).toHaveLength(1)
  })

  it('refuses the connection when the pin does not match', async () => {
    const { hub, url, fingerprint } = await startTlsHub()
    const wrongPin = (fingerprint[0] === 'a' ? 'b' : 'a') + fingerprint.slice(1)
    const dialer = makeDialer(url, { pinnedCertSha256: wrongPin })
    const errorEvent = dialer.events.once('error')
    let connected = false
    dialer.events.on('connected', () => {
      connected = true
    })
    dialer.start()
    const { error } = await errorEvent
    expect(error.message).toMatch(/fingerprint mismatch/)
    expect(connected).toBe(false)
    expect(hub.gateway.listRunners()).toHaveLength(0)
    await dialer.stop()
  })

  it('rejects a pin on a plaintext ws:// url upfront', () => {
    expect(
      () =>
        new HubDialer({
          url: 'ws://127.0.0.1:1234',
          identity: IDENTITY,
          credentialStore: createMemoryCredentialStore(),
          pinnedCertSha256: 'a'.repeat(64)
        })
    ).toThrow(/wss/)
  })
})
