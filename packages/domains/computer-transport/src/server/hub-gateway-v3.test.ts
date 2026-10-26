/**
 * Computer protocol v3 on the hub side (T-27):
 *   - a reconnect (`hello`) proves its protocol, and an older computer is refused;
 *   - `enroll`/`hello` results echo the hub's version;
 *   - every hub → computer request carries the requesting user as the envelope
 *     `actor`, from the caller's security context;
 *   - a computer's own refusal (`refusedByComputer`) reaches the caller as a clean
 *     error and is audited as `denied` — also for methods with no audit event.
 */
import { EventEmitter } from 'node:events'
import type { WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { runWithSecurityContext, setSecurityLogSink } from '@slayzone/platform/security-log'
import { COMPUTER_PROTOCOL_VERSION, ComputerTransportErrorCodes } from '../shared/frames'
import { RpcError } from '../shared/rpc'
import { createMemoryComputerAuth } from '../testing/loopback'
import { createHubComputerGateway, type HubComputerGateway } from './hub-gateway'

class FakeSocket extends EventEmitter {
  readonly sent: Record<string, unknown>[] = []
  closeCode: number | null = null
  send(line: string): void {
    this.sent.push(JSON.parse(line))
  }
  close(code?: number): void {
    this.closeCode = code ?? 1000
    this.emit('close')
  }
  terminate(): void {
    this.emit('close')
  }
  frame(msg: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg })))
  }
  response(id: number): Record<string, unknown> | undefined {
    return this.sent.find((f) => f.id === id && !('method' in f))
  }
  /** The last hub → computer request with this method. */
  requestOf(method: string): Record<string, unknown> | undefined {
    return [...this.sent].reverse().find((f) => f.method === method)
  }
}

let lines: Record<string, unknown>[] = []
afterEach(() => {
  setSecurityLogSink()
  lines = []
})
const flush = () => new Promise((r) => setImmediate(r))

function setup(): { gateway: HubComputerGateway; ws: FakeSocket } {
  setSecurityLogSink((line) => lines.push(JSON.parse(line)))
  const auth = createMemoryComputerAuth()
  const gateway = createHubComputerGateway({
    verifyEnrollment: auth.verifyEnrollment,
    verifyApiKey: auth.verifyApiKey,
    heartbeatTimeoutMs: 0
  })
  const ws = new FakeSocket()
  gateway.handleConnection(ws as unknown as WebSocket, { ip: '127.0.0.1' })
  return { gateway, ws }
}

async function enroll(ws: FakeSocket): Promise<{ computerId: string; apiKey: string }> {
  ws.frame({
    id: 1,
    method: 'enroll',
    params: {
      joinToken: 'jt-valid',
      name: 'c',
      platform: 'linux-x64',
      version: '0.0.0',
      capabilities: [],
      protocolVersion: COMPUTER_PROTOCOL_VERSION
    }
  })
  await flush()
  const result = ws.response(1)?.result as {
    computerId: string
    apiKey: string
    protocolVersion: number
  }
  expect(result.protocolVersion).toBe(COMPUTER_PROTOCOL_VERSION)
  return result
}

describe('hello carries the protocol version', () => {
  it('refuses a pre-v3 computer reconnecting, and audits it', async () => {
    const { gateway, ws } = setup()
    const { apiKey } = await enroll(ws)
    gateway.close()

    const second = setup()
    second.ws.frame({ id: 2, method: 'hello', params: { apiKey } })
    await flush()
    expect(second.ws.response(2)?.error).toMatchObject({
      code: ComputerTransportErrorCodes.protocolMismatch,
      message: expect.stringMatching(/upgrade this computer/)
    })
    expect(second.ws.closeCode).toBe(1008)
    expect(lines.find((l) => l.event === 'computer.hello')).toMatchObject({
      outcome: 'failure',
      detail: { reason: 'protocol_mismatch' }
    })
  })

  it('echoes the hub version on a v3 hello', async () => {
    const auth = createMemoryComputerAuth()
    const gateway = createHubComputerGateway({
      verifyEnrollment: auth.verifyEnrollment,
      verifyApiKey: auth.verifyApiKey,
      heartbeatTimeoutMs: 0
    })
    const a = new FakeSocket()
    gateway.handleConnection(a as unknown as WebSocket, { ip: '127.0.0.1' })
    const { apiKey } = await enroll(a)
    const b = new FakeSocket()
    gateway.handleConnection(b as unknown as WebSocket, { ip: '127.0.0.1' })
    b.frame({
      id: 2,
      method: 'hello',
      params: { apiKey, protocolVersion: COMPUTER_PROTOCOL_VERSION }
    })
    await flush()
    expect(b.response(2)?.result).toMatchObject({ protocolVersion: COMPUTER_PROTOCOL_VERSION })
    gateway.close()
  })
})

describe('the actor rides on every hub → computer request', () => {
  it('fills it from the caller context, and null for the hub acting alone', async () => {
    const { gateway, ws } = setup()
    const { computerId } = await enroll(ws)

    void runWithSecurityContext({ actor: 'user-7', ip: '10.0.0.1', route: 'trpc pty.create' }, () =>
      gateway.request(computerId, 'pty.list', {}).catch(() => {})
    )
    expect(ws.requestOf('pty.list')?.actor).toEqual({ userId: 'user-7', route: 'trpc pty.create' })

    void gateway.request(computerId, 'project.list', {}).catch(() => {})
    expect(ws.requestOf('project.list')?.actor).toEqual({ userId: null, route: null })
    gateway.close()
  })
})

describe('a computer refusal is a clean, audited error', () => {
  async function refusedCall(method: string, params: unknown): Promise<unknown> {
    const { gateway, ws } = setup()
    const { computerId } = await enroll(ws)
    const pending = gateway.request(computerId, method, params).then(
      () => null,
      (e: unknown) => e
    )
    const sent = ws.requestOf(method)!
    ws.frame({
      id: sent.id,
      error: { code: ComputerTransportErrorCodes.refusedByComputer, message: 'set on the computer' }
    })
    const err = await pending
    gateway.close()
    return err
  }

  it('an audited method (computer.setAllowedRoots) is audited as denied', async () => {
    const err = await refusedCall('computer.setAllowedRoots', { roots: ['/srv'] })
    expect(err).toBeInstanceOf(RpcError)
    expect((err as RpcError).message).toBe('set on the computer')
    expect(lines.find((l) => l.event === 'computer.allowed_roots.set')).toMatchObject({
      outcome: 'denied',
      detail: { code: ComputerTransportErrorCodes.refusedByComputer }
    })
  })

  it('an unaudited method (fs.readFile) still leaves a computer.refused line', async () => {
    const err = await refusedCall('fs.readFile', { rootPath: '/etc', filePath: 'hosts' })
    expect((err as RpcError).code).toBe(ComputerTransportErrorCodes.refusedByComputer)
    expect(lines.find((l) => l.event === 'computer.refused')).toMatchObject({
      outcome: 'denied',
      targetKind: 'computer',
      detail: { method: 'fs.readFile', code: ComputerTransportErrorCodes.refusedByComputer }
    })
  })
})
