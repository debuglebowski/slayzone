/**
 * Frame limit, end to end over a real `ws` pair (hub gateway ↔ computer dialer).
 *
 * 2026-11-14: one 202 MB chat-history reply exceeded ws's 100 MiB `maxPayload`, the
 * hub closed the computer socket (1009) and every terminal, chat and process on it
 * detached. A frame over the limit must fail ONE request, never the connection.
 * The limit is lowered here (options seam) so the tests move kilobytes, not 100 MiB.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryCredentialStore } from '../client/credential-store'
import { HubDialer, type HubDialerOptions } from '../client/hub-dialer'
import { COMPUTER_FRAME_MAX_BYTES } from '../shared/frame-limit'
import { ComputerTransportErrorCodes, HubToComputerMethods } from '../shared/frames'
import { RpcError } from '../shared/rpc'
import { createHubComputerGateway } from './hub-gateway'
import { startLoopbackHub, type LoopbackHub } from '../testing/loopback'

const LIMIT = 64 * 1024
const BIG = 'x'.repeat(LIMIT + 1)

const IDENTITY = {
  name: 'test-computer',
  platform: 'darwin-arm64',
  version: '0.0.0',
  capabilities: ['pty']
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

interface Diag {
  event: string
  payload: Record<string, unknown>
}

async function startHub(maxFrameBytes = LIMIT): Promise<LoopbackHub & { diags: Diag[] }> {
  const diags: Diag[] = []
  const hub = await startLoopbackHub({
    maxFrameBytes,
    diagnostic: (event, payload) => diags.push({ event, payload })
  })
  cleanups.push(() => hub.close())
  return Object.assign(hub, { diags })
}

async function connect(
  hub: LoopbackHub,
  overrides: Partial<HubDialerOptions> = {}
): Promise<{ dialer: HubDialer; computerId: string; logs: string[] }> {
  const logs: string[] = []
  const dialer = new HubDialer({
    url: hub.url,
    identity: IDENTITY,
    credentialStore: createMemoryCredentialStore(),
    joinToken: 'jt-valid',
    heartbeatIntervalMs: 0,
    backoff: { initialDelayMs: 10, maxDelayMs: 50, multiplier: 2, jitterRatio: 0 },
    maxFrameBytes: LIMIT,
    log: (message) => logs.push(message),
    ...overrides
  })
  cleanups.push(() => dialer.stop())
  const connected = dialer.events.once('connected')
  dialer.start()
  const { computerId } = await connected
  return { dialer, computerId, logs }
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e
  )
}

describe('frame limit — wiring', () => {
  it('gateway and dialer default to the shared limit, and the loopback ws enforces it', async () => {
    const gateway = createHubComputerGateway({
      verifyEnrollment: async () => ({ computerId: 'c', apiKey: 'k' }),
      verifyApiKey: async () => null
    })
    expect(gateway.maxFrameBytes).toBe(COMPUTER_FRAME_MAX_BYTES)
    gateway.close()
    const hub = await startHub()
    expect(hub.wss.options.maxPayload).toBe(LIMIT)
  })
})

describe('frame limit — an oversized reply fails one request, not the connection', () => {
  it('the hub caller gets frameTooLarge naming the method; the socket and other work survive', async () => {
    const hub = await startHub()
    let releaseSlow: (v: unknown) => void = () => undefined
    const { dialer, computerId } = await connect(hub, {
      onHubRequest: async (method, params) => {
        if (method === HubToComputerMethods.ptyList)
          return new Promise((resolve) => {
            releaseSlow = resolve
          })
        if (method === HubToComputerMethods.chatRequest) return { history: BIG }
        return { echo: params }
      }
    })
    const disconnected: string[] = []
    hub.gateway.events.on('computer-disconnected', ({ reason }) => disconnected.push(reason))

    // Another session's request in flight while the oversized one fails.
    const slow = hub.gateway.request(computerId, HubToComputerMethods.ptyList, {})
    const err = await rejection(
      hub.gateway.request(computerId, HubToComputerMethods.chatRequest, {})
    )
    expect(err).toBeInstanceOf(RpcError)
    expect((err as RpcError).code).toBe(ComputerTransportErrorCodes.frameTooLarge)
    expect((err as RpcError).message).toContain(`'${HubToComputerMethods.chatRequest}'`)
    expect((err as RpcError).data).toMatchObject({
      method: HubToComputerMethods.chatRequest,
      limitBytes: LIMIT
    })

    // Same connection: a second request works, the in-flight one completes,
    // notifications still flow.
    await expect(
      hub.gateway.request(computerId, HubToComputerMethods.ping, {})
    ).resolves.toBeDefined()
    releaseSlow({ sessions: [] })
    await expect(slow).resolves.toEqual({ sessions: [] })
    const data = hub.gateway.events.once('pty.data')
    expect(dialer.notify('pty.data', { sessionId: 's', seq: 1, data: 'after' })).toBe(true)
    expect((await data).data).toBe('after')

    expect(disconnected).toEqual([])
    expect(hub.gateway.listComputers().map((c) => c.computerId)).toEqual([computerId])
    expect(hub.diags).toContainEqual({
      event: 'computer.reply_too_large',
      payload: expect.objectContaining({
        computerId,
        method: HubToComputerMethods.chatRequest,
        limitBytes: LIMIT
      })
    })
  })

  it('an oversized hub request is refused before sending; the computer never sees it', async () => {
    const hub = await startHub()
    const seen: string[] = []
    const { computerId } = await connect(hub, {
      onHubRequest: async (method) => {
        seen.push(method)
        return { ok: true }
      }
    })
    const err = await rejection(
      hub.gateway.request(computerId, HubToComputerMethods.fsWriteFile, { content: BIG })
    )
    expect((err as RpcError).code).toBe(ComputerTransportErrorCodes.frameTooLarge)
    expect((err as RpcError).message).toContain(`'${HubToComputerMethods.fsWriteFile}'`)
    expect(seen).toEqual([])
    await expect(
      hub.gateway.request(computerId, HubToComputerMethods.fsPathExists, { path: '/x' })
    ).resolves.toEqual({ ok: true })
    expect(hub.diags).toContainEqual({
      event: 'computer.frame_too_large',
      payload: expect.objectContaining({
        computerId,
        direction: 'outbound',
        kind: 'request',
        method: HubToComputerMethods.fsWriteFile
      })
    })
  })

  it('symmetric: an oversized computer → hub request is refused locally', async () => {
    const hub = await startHub()
    const { dialer, logs } = await connect(hub)
    const protocolErrors: string[] = []
    hub.gateway.events.on('protocol-error', ({ detail }) => protocolErrors.push(detail))
    const err = await rejection(dialer.request('computer.event', { id: 'e', params: BIG }))
    expect((err as RpcError).code).toBe(ComputerTransportErrorCodes.frameTooLarge)
    expect(dialer.state).toBe('connected')
    expect(logs.some((l) => l.includes('frame'))).toBe(true)
    expect(protocolErrors).toEqual([])
  })

  it('an oversized computer notification is dropped and logged, the link stays up', async () => {
    const hub = await startHub()
    const { dialer, logs } = await connect(hub)
    expect(() => dialer.notify('pty.data', { sessionId: 's', seq: 1, data: BIG })).not.toThrow()
    const data = hub.gateway.events.once('pty.data')
    dialer.notify('pty.data', { sessionId: 's', seq: 2, data: 'small' })
    expect((await data).seq).toBe(2)
    expect(logs.some((l) => l.includes('frame'))).toBe(true)
  })
})

describe('frame limit — a peer that ignores it', () => {
  it('the hub names the violation (limit + in-flight methods) instead of a silent 1009', async () => {
    const hub = await startHub()
    // A non-conforming computer: its own cap is far above the hub's.
    const { computerId } = await connect(hub, {
      maxFrameBytes: LIMIT * 4,
      onHubRequest: async () => ({ history: BIG })
    })
    const disconnected = hub.gateway.events.once('computer-disconnected')
    const err = await rejection(
      hub.gateway.request(computerId, HubToComputerMethods.chatRequest, {})
    )
    expect(err).toBeInstanceOf(Error)
    expect((await disconnected).reason).toBe('frame-too-large')
    expect(hub.diags).toContainEqual({
      event: 'computer.frame_too_large',
      payload: expect.objectContaining({
        computerId,
        direction: 'inbound',
        limitBytes: LIMIT,
        pendingMethods: [HubToComputerMethods.chatRequest]
      })
    })
  })

  it('the computer names an oversized hub frame the same way', async () => {
    const hub = await startHub(LIMIT * 4)
    const { computerId, logs } = await connect(hub, { onHubRequest: async () => ({ ok: true }) })
    const err = await rejection(
      hub.gateway.request(computerId, HubToComputerMethods.fsWriteFile, { content: BIG })
    )
    expect(err).toBeInstanceOf(Error)
    expect(logs.some((l) => l.includes('exceeded the frame limit'))).toBe(true)
  })
})
