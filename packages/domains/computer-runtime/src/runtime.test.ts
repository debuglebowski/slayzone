import { describe, expect, it } from 'vitest'
import { connect, createServer, type AddressInfo, type Socket } from 'node:net'
import { RpcError } from '@slayzone/computer-transport/shared'
import { ConnectorLease, RetryPolicy, socketPeer } from './index'

describe('persistent runtime fencing', () => {
  it('fences old connector without disposing its sessions, including rollback', () => {
    const lease = new ConnectorLease()
    expect(lease.claim(1)).toBe(true)
    expect(lease.claim(2)).toBe(true)
    expect(lease.claim(1)).toBe(false)
    expect(lease.isCurrent(1)).toBe(false)
    expect(lease.claim(3)).toBe(true)
  })
  it('quarantines failing targets and clears on target change', () => {
    const retry = new RetryPolicy(() => 0.5)
    expect(retry.fail('v2', 0)).toBe(5000)
    retry.fail('v2', 5000)
    expect(retry.fail('v2', 15000)).toBe(900000)
    expect(retry.ready('v2', 16000)).toBe(false)
    expect(retry.ready('v3', 16000)).toBe(true)
  })
})

it('retains release cooldown after supervisor restart', () => {
  const original = new RetryPolicy(() => 0.5)
  original.quarantine('2.0.0', 1000)
  const resumed = new RetryPolicy(() => 0.5, original.snapshot())
  expect(resumed.ready('2.0.0', 2000)).toBe(false)
  expect(resumed.ready('3.0.0', 2000)).toBe(true)
  expect(resumed.ready('2.0.0', 901000)).toBe(true)
})

describe('socketPeer', () => {
  it("relays a handler's structured error whole: code, message and data", async () => {
    const [a, b] = await socketPair()
    const host = socketPeer(a, {
      request: () => {
        throw new RpcError(-32603, "ENOENT: no such file, stat '/x'", { errno: 'ENOENT' })
      }
    })
    const connector = socketPeer(b)
    const err = await connector.rpc.request('fs.readBytes', {}).then(
      () => null,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(RpcError)
    expect(err).toMatchObject({
      code: -32603,
      message: "ENOENT: no such file, stat '/x'",
      data: { errno: 'ENOENT' }
    })
    host.close()
    connector.close()
  })
})

function socketPair(): Promise<[Socket, Socket]> {
  return new Promise((resolve, reject) => {
    const server = createServer((serverSide) => {
      server.close()
      resolve([serverSide, client])
    })
    server.on('error', reject)
    let client: Socket
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      client = connect(addr.port, '127.0.0.1')
    })
  })
}
