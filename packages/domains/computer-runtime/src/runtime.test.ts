import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  COMPUTER_FRAME_MAX_BYTES,
  ComputerTransportErrorCodes,
  RpcError
} from '@slayzone/computer-transport/shared'
import { ConnectorLease, RetryPolicy, connectLocal, socketPeer, type LocalPeer } from './index'

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

describe('local link frame limit (connector ↔ session host)', () => {
  const LIMIT = 16 * 1024
  const cleanups: Array<() => void> = []
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!()
  })

  async function pair(
    request: (method: string) => unknown,
    frameLimitBytes: number | null = LIMIT
  ): Promise<{ client: LocalPeer; server: () => LocalPeer | undefined }> {
    const dir = mkdtempSync(join(tmpdir(), 'slz-fl-'))
    // Windows has no filesystem unix sockets: `listen` on a %TEMP% path is EACCES.
    // Use a named pipe there, as the product's hostEndpoint does.
    const endpoint =
      process.platform === 'win32' ? `\\\\.\\pipe\\${basename(dir)}` : join(dir, 's.sock')
    let serverPeer: LocalPeer | undefined
    const server: Server = createServer((socket) => {
      serverPeer = socketPeer(socket, {
        ...(frameLimitBytes === null ? {} : { frameLimitBytes }),
        request: async (m) => request(m)
      })
    })
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    const client = await connectLocal(endpoint, frameLimitBytes === null ? {} : { frameLimitBytes })
    cleanups.push(() => {
      client.close()
      serverPeer?.close()
      server.close()
      rmSync(dir, { recursive: true, force: true })
    })
    return { client, server: () => serverPeer }
  }

  it('defaults to the shared computer frame limit', async () => {
    const { client } = await pair(() => 'ok', null)
    expect(client.rpc.maxFrameBytes).toBe(COMPUTER_FRAME_MAX_BYTES)
  })

  it('an oversized reply fails that request; the local socket stays up', async () => {
    const { client } = await pair((m) => (m === 'big' ? 'x'.repeat(LIMIT + 1) : 'ok'))
    const err = await client.rpc.request('big').then(
      () => null,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(RpcError)
    expect((err as RpcError).code).toBe(ComputerTransportErrorCodes.frameTooLarge)
    expect((err as RpcError).message).toContain("'big'")
    expect(client.socket.destroyed).toBe(false)
    await expect(client.rpc.request('small')).resolves.toBe('ok')
  })

  it('a hub request relayed as dispatch names the HUB method when its reply is too large', async () => {
    const { client } = await pair((m) => (m === 'dispatch' ? 'x'.repeat(LIMIT + 1) : 'ok'))
    const err = await client.rpc
      .request('dispatch', { method: 'chat.request', params: {}, actor: null })
      .then(
        () => null,
        (e: unknown) => e
      )
    expect((err as RpcError).code).toBe(ComputerTransportErrorCodes.frameTooLarge)
    expect((err as RpcError).message).toContain("reply to 'chat.request'")
    expect((err as RpcError).message).not.toContain('dispatch')
    expect((err as RpcError).data).toMatchObject({ method: 'chat.request' })
  })

  it('a hub request too large for the local link names the HUB method', async () => {
    const { client } = await pair(() => 'ok')
    const err = await client.rpc
      .request('dispatch', { method: 'fs.writeFile', params: { content: 'w'.repeat(LIMIT) } })
      .then(
        () => null,
        (e: unknown) => e
      )
    expect((err as RpcError).message).toContain("request 'fs.writeFile'")
    expect((err as RpcError).data).toMatchObject({ method: 'fs.writeFile' })
  })

  it('a reply of exactly the limit is delivered (newline framing is not counted)', async () => {
    const overhead = JSON.stringify({ jsonrpc: '2.0', id: 1, result: '' }).length
    const { client } = await pair(() => 'y'.repeat(LIMIT - overhead))
    await expect(client.rpc.request('exact')).resolves.toHaveLength(LIMIT - overhead)
    expect(client.socket.destroyed).toBe(false)
  })

  it('a peer that ignores the limit still loses its socket (receive guard)', async () => {
    const { client, server } = await pair(() => 'ok')
    await expect(client.rpc.request('warmup')).resolves.toBe('ok')
    // One write: a whole line over the limit, completed in the same chunk.
    client.socket.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'n', params: 'q'.repeat(LIMIT) })}\n`
    )
    await new Promise<void>((resolve) => client.socket.once('close', () => resolve()))
    expect(server()?.socket.destroyed).toBe(true)
  })

  it('an oversized request is refused locally and never reaches the host', async () => {
    const seen: string[] = []
    const { client } = await pair((m) => {
      seen.push(m)
      return 'ok'
    })
    const err = await client.rpc.request('dispatch', { blob: 'z'.repeat(LIMIT) }).then(
      () => null,
      (e: unknown) => e
    )
    expect((err as RpcError).code).toBe(ComputerTransportErrorCodes.frameTooLarge)
    await expect(client.rpc.request('next')).resolves.toBe('ok')
    expect(seen).toEqual(['next'])
  })
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

describe('local link write buffer (flow control)', () => {
  const MiB = 1024 * 1024
  const closed = (socket: Socket) =>
    new Promise<void>((resolve) =>
      socket.destroyed ? resolve() : socket.once('close', () => resolve())
    )

  it('a burst far over 8 MiB queued ahead of a reply still delivers the reply; the link stays up', async () => {
    // golden-comet 2026-11-23: heavy chat streaming queued > 8 MiB on the host's side
    // of the link, the host refused the next write, and a refused REPLY tore the whole
    // connector link down. A healthy reader must get every frame, the reply included.
    const [a, b] = await socketPair()
    const chunk = 'x'.repeat(MiB)
    const host = socketPeer(a, {
      request: () => {
        for (let i = 0; i < 24; i++) host.rpc.notify('event', { chunk })
        return 'answered'
      }
    })
    let received = 0
    const connector = socketPeer(b, { notify: () => void received++ })
    try {
      await expect(connector.rpc.request('dispatch', {}, 10_000)).resolves.toBe('answered')
      expect(received).toBe(24)
      expect(host.closeReason()).toBeUndefined()
      expect(connector.closeReason()).toBeUndefined()
    } finally {
      host.close()
      connector.close()
    }
  })

  it('a reader paused with a backlog under the ceiling keeps the link and gets every frame', async () => {
    const [a, b] = await socketPair()
    const host = socketPeer(a, { writeCeilingBytes: 64 * MiB })
    let received = 0
    const connector = socketPeer(b, { notify: () => void received++ })
    b.pause()
    try {
      const chunk = 'x'.repeat(MiB)
      for (let i = 0; i < 16; i++) host.rpc.notify('event', { chunk })
      await new Promise((r) => setTimeout(r, 300))
      expect(host.closeReason()).toBeUndefined()
      b.resume()
      while (received < 16) await new Promise((r) => setTimeout(r, 20))
      expect(host.closeReason()).toBeUndefined()
    } finally {
      host.close()
      connector.close()
    }
  })

  it('queued bytes over the ceiling drop the link at once, with the reason', async () => {
    const [a, b] = await socketPair()
    const host = socketPeer(a, { writeCeilingBytes: 4 * MiB })
    const connector = socketPeer(b)
    b.pause()
    try {
      const chunk = 'x'.repeat(MiB)
      for (let i = 0; i < 8; i++) host.rpc.notify('event', { chunk })
      await closed(a)
      expect(host.closeReason()).toMatch(
        /peer not reading fast enough: .* MiB queued over the 4\.0 MiB ceiling/
      )
    } finally {
      host.close()
      connector.close()
    }
  })

  it('a write after the link closed fails that write, not silently', async () => {
    const [a, b] = await socketPair()
    const host = socketPeer(a)
    const connector = socketPeer(b)
    host.close()
    await expect(host.rpc.request('x')).rejects.toThrow()
    connector.close()
  })
})

it('local connector relay carries cancellation by request id into the host handler', async () => {
  const [a, b] = await socketPair()
  let entered!: () => void, finish!: () => void, signal: AbortSignal | undefined
  const accepted = new Promise<void>((resolve) => {
    entered = resolve
  })
  const held = new Promise<void>((resolve) => {
    finish = resolve
  })
  const host = socketPeer(a, {
    request: async (_method, _params, _actor, current) => {
      signal = current
      entered()
      await held
      return 'finished'
    }
  })
  const connector = socketPeer(b)
  const abort = new AbortController()
  try {
    const pending = connector.rpc.request('dispatch', {}, 0, undefined, abort.signal)
    void pending.catch(() => undefined)
    await accepted
    expect(signal?.aborted).toBe(false)
    const cancelled = new Promise<void>((resolve) =>
      signal!.addEventListener('abort', () => resolve(), { once: true })
    )
    abort.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await cancelled
    expect(signal?.aborted).toBe(true)
  } finally {
    finish()
    host.close()
    connector.close()
  }
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
