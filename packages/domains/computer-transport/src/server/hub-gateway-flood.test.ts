/**
 * `/computers` flood limits (T-26): unauthenticated sockets capped per address and in
 * total and refused before the upgrade, a cap on auth attempts per socket, failed
 * sockets refusing an address for a window, authenticated computers never counted, no
 * limits at all where the host turns them off, and one audit line per flood.
 *
 * Drives `handleConnection` with a fake socket so every client can have its own address.
 */
import { EventEmitter } from 'node:events'
import type { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { COMPUTER_PROTOCOL_VERSION, ComputerTransportErrorCodes } from '../shared/frames'
import { createMemoryComputerAuth } from '../testing/loopback'
import {
  type ComputerFloodLimits,
  createHubComputerGateway,
  DEFAULT_COMPUTER_FLOOD_LIMITS,
  type HubComputerGateway,
  PRE_AUTH_FRAME_MAX_BYTES
} from './hub-gateway'

class FakeSocket extends EventEmitter {
  readonly sent: Record<string, unknown>[] = []
  closeCode: number | null = null
  terminated = false
  send(line: string): void {
    this.sent.push(JSON.parse(line))
  }
  close(code?: number): void {
    this.closeCode = code ?? 1000
    this.emit('close')
  }
  terminate(): void {
    this.terminated = true
    this.emit('close')
  }
  /** One computer→hub request frame. */
  request(id: number, method: string, params: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params })))
  }
  response(id: number): Record<string, unknown> | undefined {
    return this.sent.find((f) => f.id === id)
  }
}

const LIMITS: ComputerFloodLimits = {
  pendingPerAddress: 2,
  pendingTotal: 3,
  attemptsPerSocket: 3,
  failedPerAddress: 3,
  failedWindowMs: 60_000
}

let lines: Record<string, unknown>[] = []
afterEach(() => {
  setSecurityLogSink()
  lines = []
  vi.useRealTimers()
})
const captureAudit = () => setSecurityLogSink((line) => lines.push(JSON.parse(line)))
const rateLines = () => lines.filter((l) => l.event === 'hub.rate_limit')
const flush = () => new Promise((r) => setImmediate(r))

/** `'default'`: pass no `floodLimits` at all. */
function setup(floodLimits: ComputerFloodLimits | false | 'default' = LIMITS) {
  const auth = createMemoryComputerAuth()
  const gateway = createHubComputerGateway({
    verifyEnrollment: auth.verifyEnrollment,
    verifyApiKey: auth.verifyApiKey,
    heartbeatTimeoutMs: 0,
    ...(floodLimits === 'default' ? {} : { floodLimits })
  })
  return { auth, gateway }
}

/** Accept a socket from `ip` the way the hub does: ask first, then adopt. */
function connect(gateway: HubComputerGateway, ip: string): FakeSocket | null {
  if (!gateway.admitUpgrade({ ip }).ok) return null
  const ws = new FakeSocket()
  gateway.handleConnection(ws as unknown as WebSocket, { ip })
  return ws
}

/** Enroll on `ws` with the valid join token; resolves once the hub answered. */
async function enroll(ws: FakeSocket, id = 1): Promise<void> {
  ws.request(id, 'enroll', {
    joinToken: 'jt-valid',
    name: `c-${id}`,
    platform: 'linux-x64',
    version: '0.0.0',
    capabilities: [],
    protocolVersion: COMPUTER_PROTOCOL_VERSION
  })
  await flush()
  expect(ws.response(id)?.result).toBeDefined()
}

describe('/computers flood limits', () => {
  it('caps unauthenticated sockets per address and in total, before the upgrade', () => {
    captureAudit()
    const { gateway } = setup()
    expect(connect(gateway, '203.0.113.1')).not.toBeNull()
    expect(connect(gateway, '203.0.113.1')).not.toBeNull()
    expect(gateway.admitUpgrade({ ip: '203.0.113.1' })).toEqual({
      ok: false,
      status: 429,
      retryAfterSec: 1,
      limit: 'computers.pending_per_address'
    })
    // Another address still gets in, up to the hub-wide cap.
    expect(connect(gateway, '203.0.113.2')).not.toBeNull()
    expect(gateway.admitUpgrade({ ip: '203.0.113.3' })).toMatchObject({
      ok: false,
      status: 503,
      limit: 'computers.pending_total'
    })
    // Every refused upgrade from one address: one audit line per limit.
    for (let i = 0; i < 20; i++) gateway.admitUpgrade({ ip: '203.0.113.1' })
    expect(rateLines().map((l) => [l.ip, (l.detail as { limit: string }).limit])).toEqual([
      ['203.0.113.1', 'computers.pending_per_address'],
      ['203.0.113.3', 'computers.pending_total']
    ])
    expect(rateLines()[0]).toMatchObject({ outcome: 'denied', route: 'WS /computers' })
  })

  it('an IPv6 client is one address per /64', () => {
    const { gateway } = setup()
    expect(connect(gateway, '2001:db8:1:2::a')).not.toBeNull()
    expect(connect(gateway, '2001:db8:1:2::b')).not.toBeNull()
    expect(gateway.admitUpgrade({ ip: '2001:db8:1:2::c' }).ok).toBe(false)
  })

  it('a socket adopted without asking first is refused the same way, and holds nothing', () => {
    const { gateway } = setup()
    connect(gateway, '203.0.113.1')
    connect(gateway, '203.0.113.1')
    const extra = new FakeSocket()
    gateway.handleConnection(extra as unknown as WebSocket, { ip: '203.0.113.1' })
    expect(extra.terminated).toBe(true)
    // It took no slot: another address still fits under the total.
    expect(gateway.admitUpgrade({ ip: '203.0.113.9' }).ok).toBe(true)
  })

  it('authenticated computers are not counted: any number from one address', async () => {
    const { gateway } = setup()
    for (let i = 1; i <= 10; i++) {
      const ws = connect(gateway, '203.0.113.5')
      expect(ws, `computer ${i} admitted`).not.toBeNull()
      await enroll(ws!, i)
    }
    expect(gateway.listComputers()).toHaveLength(10)
    expect(gateway.admitUpgrade({ ip: '203.0.113.5' }).ok).toBe(true)
  })

  it('closes a socket past its auth attempts; a computer needs at most three', async () => {
    captureAudit()
    const { gateway } = setup()
    const ws = connect(gateway, '203.0.113.6')!
    for (let id = 1; id <= LIMITS.attemptsPerSocket; id++) {
      ws.request(id, 'hello', { apiKey: `wrong-${id}`, protocolVersion: COMPUTER_PROTOCOL_VERSION })
      await flush()
      expect(ws.response(id)?.error).toMatchObject({ message: 'unknown api key' })
    }
    expect(ws.closeCode).toBeNull()
    ws.request(99, 'hello', { apiKey: 'wrong-99', protocolVersion: COMPUTER_PROTOCOL_VERSION })
    expect(ws.response(99)?.error).toMatchObject({
      code: ComputerTransportErrorCodes.unauthorized,
      message: 'too many authentication attempts on one connection'
    })
    expect(ws.closeCode).toBe(1008)
    expect(rateLines()).toHaveLength(1)
    expect((rateLines()[0]!.detail as { limit: string }).limit).toBe(
      'computers.attempts_per_socket'
    )
  })

  it('sockets that end unauthenticated refuse their address for the window', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    captureAudit()
    const { gateway } = setup()
    for (let i = 0; i < LIMITS.failedPerAddress; i++) connect(gateway, '203.0.113.7')!.close()
    const refused = gateway.admitUpgrade({ ip: '203.0.113.7' })
    expect(refused).toMatchObject({ ok: false, status: 429, limit: 'computers.failed_per_address' })
    expect(refused.ok === false && refused.retryAfterSec).toBe(60)
    expect(gateway.admitUpgrade({ ip: '203.0.113.8' }).ok).toBe(true)
    vi.advanceTimersByTime(LIMITS.failedWindowMs)
    expect(gateway.admitUpgrade({ ip: '203.0.113.7' }).ok).toBe(true)
    expect(rateLines()).toHaveLength(1)
  })

  it('an auth timeout is a failed socket and frees its slot', () => {
    vi.useFakeTimers()
    const auth = createMemoryComputerAuth()
    const gateway = createHubComputerGateway({
      verifyEnrollment: auth.verifyEnrollment,
      verifyApiKey: auth.verifyApiKey,
      heartbeatTimeoutMs: 0,
      authTimeoutMs: 1_000,
      floodLimits: { ...LIMITS, failedPerAddress: 1 }
    })
    const ws = connect(gateway, '203.0.113.12')!
    vi.advanceTimersByTime(1_000)
    expect(ws.terminated).toBe(true)
    expect(gateway.admitUpgrade({ ip: '203.0.113.12' })).toMatchObject({
      limit: 'computers.failed_per_address'
    })
    // The slot is free again for everyone else.
    expect(connect(gateway, '203.0.113.13')).not.toBeNull()
    expect(connect(gateway, '203.0.113.13')).not.toBeNull()
    expect(connect(gateway, '203.0.113.14')).not.toBeNull()
  })

  it('off (a hub no other machine reaches): nothing is refused or counted', async () => {
    captureAudit()
    const { gateway } = setup(false)
    for (let i = 0; i < 50; i++) expect(connect(gateway, '127.0.0.1')).not.toBeNull()
    const ws = connect(gateway, '127.0.0.1')!
    for (let id = 1; id <= 10; id++)
      ws.request(id, 'hello', { apiKey: 'wrong', protocolVersion: COMPUTER_PROTOCOL_VERSION })
    await flush()
    expect(ws.closeCode).toBeNull()
    expect(rateLines()).toHaveLength(0)
  })

  it('defaults apply when the host passes nothing', () => {
    const { gateway } = setup('default')
    for (let i = 0; i < DEFAULT_COMPUTER_FLOOD_LIMITS.pendingPerAddress; i++) {
      expect(connect(gateway, '203.0.113.20')).not.toBeNull()
    }
    expect(gateway.admitUpgrade({ ip: '203.0.113.20' }).ok).toBe(false)
  })
})

/**
 * Before enroll/hello succeeds a socket is anyone's, and ws accepts a 100 MiB frame by
 * default. zod <= 4.6.5 allocates one issue per failing array element
 * (GHSA-mrhx-c7xc-m3w5): `capabilities: [0, 0, …]` in a 100 MiB enroll frame is ~50M
 * issues, many GiB, an out-of-memory hub with no credential at all. Unauthenticated
 * frames are therefore capped far below that, before JSON.parse and zod see them.
 */
describe('/computers unauthenticated frame size', () => {
  const bigEnroll = (n: number) =>
    Buffer.from(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'enroll',
        params: {
          joinToken: 'jt-valid',
          name: 'c',
          platform: 'linux-x64',
          version: '0.0.0',
          capabilities: Array(n).fill(0),
          protocolVersion: COMPUTER_PROTOCOL_VERSION
        }
      })
    )

  it('closes a socket whose unauthenticated frame is over the cap, unparsed', async () => {
    const { gateway } = setup(false)
    const errors: string[] = []
    gateway.events.on('protocol-error', (e: { detail: string }) => errors.push(e.detail))
    const ws = connect(gateway, '203.0.113.30')!
    const frame = bigEnroll(PRE_AUTH_FRAME_MAX_BYTES)
    expect(frame.byteLength).toBeGreaterThan(PRE_AUTH_FRAME_MAX_BYTES)
    ws.emit('message', frame)
    await flush()
    expect(ws.closeCode).toBe(1009)
    expect(ws.sent).toEqual([])
    expect(errors.some((d) => d.includes('unauthenticated frame'))).toBe(true)
  })

  it('a real enroll frame is far below the cap', async () => {
    const { gateway } = setup(false)
    const ws = connect(gateway, '203.0.113.31')!
    await enroll(ws)
    expect(ws.closeCode).toBeNull()
  })

  it('an authenticated computer may send frames over the cap', async () => {
    const { gateway } = setup(false)
    const ws = connect(gateway, '203.0.113.32')!
    await enroll(ws)
    ws.request(2, 'heartbeat', { ts: 1, pad: 'x'.repeat(PRE_AUTH_FRAME_MAX_BYTES * 2) })
    await flush()
    expect(ws.closeCode).toBeNull()
    expect(ws.response(2)?.result).toBeDefined()
  })
})
