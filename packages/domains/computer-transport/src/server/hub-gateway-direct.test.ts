/**
 * Protocol v8 (direct link): a computer advertises its direct-listener authority in
 * `enroll` / `hello`, and the hub keeps it per live connection with whether the
 * computer's link is a loopback peer (the hub's reachability rule needs both).
 */
import { EventEmitter } from 'node:events'
import type { WebSocket } from 'ws'
import { describe, expect, it } from 'vitest'
import { COMPUTER_PROTOCOL_VERSION } from '../shared/frames'
import { createMemoryComputerAuth } from '../testing/loopback'
import { createHubComputerGateway } from './hub-gateway'

class FakeSocket extends EventEmitter {
  readonly sent: Record<string, unknown>[] = []
  send(line: string): void {
    this.sent.push(JSON.parse(line))
  }
  close(): void {
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
}
const flush = () => new Promise((r) => setImmediate(r))

function setup(ip: string) {
  const auth = createMemoryComputerAuth()
  const gateway = createHubComputerGateway({
    verifyEnrollment: auth.verifyEnrollment,
    verifyApiKey: auth.verifyApiKey,
    heartbeatTimeoutMs: 0
  })
  const connect = () => {
    const ws = new FakeSocket()
    gateway.handleConnection(ws as unknown as WebSocket, { ip })
    return ws
  }
  return { gateway, connect }
}

function enrollFrame(directAddress?: string | null, directRtc?: boolean) {
  return {
    id: 1,
    method: 'enroll',
    params: {
      joinToken: 'jt-valid',
      name: 'c',
      platform: 'linux-x64',
      version: '0.0.0',
      capabilities: [],
      protocolVersion: COMPUTER_PROTOCOL_VERSION,
      ...(directAddress !== undefined ? { directAddress } : {}),
      ...(directRtc !== undefined ? { directRtc } : {})
    }
  }
}

describe('protocol v8: direct-link address', () => {
  it('is v8', () => {
    expect(COMPUTER_PROTOCOL_VERSION).toBe(8)
  })

  it('keeps the address an enrolling computer advertises, and its loopback-ness', async () => {
    const { gateway, connect } = setup('127.0.0.1')
    connect().frame(enrollFrame('127.0.0.1:53111'))
    await flush()
    expect(gateway.listComputers()[0]).toMatchObject({
      directAddress: '127.0.0.1:53111',
      peerLoopback: true
    })
    gateway.close()
  })

  it('takes the address from hello on reconnect, from the frame and not from before', async () => {
    const { gateway, connect } = setup('203.0.113.9')
    const first = connect()
    first.frame(enrollFrame('box.example:7443'))
    await flush()
    const { apiKey } = first.response(1)!.result as { apiKey: string }
    first.close()
    const second = connect()
    second.frame({
      id: 2,
      method: 'hello',
      params: { apiKey, protocolVersion: COMPUTER_PROTOCOL_VERSION, directAddress: null }
    })
    await flush()
    expect(second.response(2)?.result).toBeTruthy()
    expect(gateway.listComputers()[0]).toMatchObject({ directAddress: null, peerLoopback: false })
    gateway.close()
  })

  it('treats an absent address as none', async () => {
    const { gateway, connect } = setup('127.0.0.1')
    connect().frame(enrollFrame())
    await flush()
    expect(gateway.listComputers()[0]?.directAddress).toBeNull()
    gateway.close()
  })

  it('drops an address that is not a bare authority (a URL, a path), keeping the computer', async () => {
    for (const bad of ['ws://box:1', 'box:1/x', 'a b']) {
      const { gateway, connect } = setup('127.0.0.1')
      const ws = connect()
      ws.frame(enrollFrame(bad))
      await flush()
      expect(ws.response(1)?.result).toBeTruthy()
      expect(gateway.listComputers()[0]?.directAddress).toBeNull()
      gateway.close()
    }
  })

  it('keeps whether the computer answers WebRTC offers (absent = no)', async () => {
    for (const [advertised, kept] of [
      [true, true],
      [false, false],
      [undefined, false]
    ] as const) {
      const { gateway, connect } = setup('203.0.113.9')
      connect().frame(enrollFrame(null, advertised))
      await flush()
      expect(gateway.listComputers()[0]?.directRtc).toBe(kept)
      gateway.close()
    }
  })
})
