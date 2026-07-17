import { afterEach, describe, expect, it, vi } from 'vitest'
import { DuplexRpc, LineDecoder, RpcDisposedError, RpcError, RpcTimeoutError } from './rpc'

interface Harness {
  rpc: DuplexRpc
  written: string[]
  peerRequests: Array<{ method: string; params: unknown; id: string | number }>
  notifications: Array<{ method: string; params: unknown }>
  parseErrors: Array<{ line: string; err: unknown }>
}

function makeRpc(overrides: Partial<ConstructorParameters<typeof DuplexRpc>[0]> = {}): Harness {
  const written: string[] = []
  const peerRequests: Harness['peerRequests'] = []
  const notifications: Harness['notifications'] = []
  const parseErrors: Harness['parseErrors'] = []
  const rpc = new DuplexRpc({
    write: (line) => written.push(line),
    onPeerRequest: (method, params, id) => peerRequests.push({ method, params, id }),
    onNotification: (method, params) => notifications.push({ method, params }),
    onParseError: (line, err) => parseErrors.push({ line, err }),
    ...overrides
  })
  return { rpc, written, peerRequests, notifications, parseErrors }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('DuplexRpc request/response correlation', () => {
  it('resolves out-of-order responses to the right callers', async () => {
    const { rpc, written } = makeRpc()
    const a = rpc.request('alpha')
    const b = rpc.request('beta')
    const [idA, idB] = written.map((w) => JSON.parse(w).id as number)
    // Respond to B first, then A.
    rpc.handleLine(JSON.stringify({ id: idB, result: { from: 'beta' } }))
    rpc.handleLine(JSON.stringify({ id: idA, result: { from: 'alpha' } }))
    await expect(b).resolves.toEqual({ from: 'beta' })
    await expect(a).resolves.toEqual({ from: 'alpha' })
    expect(rpc.pendingCount).toBe(0)
  })

  it('accepts responses without a jsonrpc field', async () => {
    const { rpc, written } = makeRpc()
    const p = rpc.request('m')
    const id = JSON.parse(written[0]!).id as number
    rpc.handleLine(JSON.stringify({ id, result: 42 }))
    await expect(p).resolves.toBe(42)
  })

  it('rejects with RpcError carrying code and data on error replies', async () => {
    const { rpc, written } = makeRpc()
    const p = rpc.request('m')
    const id = JSON.parse(written[0]!).id as number
    rpc.handleLine(JSON.stringify({ id, error: { code: -32001, message: 'unimplemented: m', data: { x: 1 } } }))
    const err = await p.then(
      () => null,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(RpcError)
    expect((err as RpcError).code).toBe(-32001)
    expect((err as RpcError).message).toBe('unimplemented: m')
    expect((err as RpcError).data).toEqual({ x: 1 })
  })

  it('silently ignores a response for an unknown id', () => {
    const { rpc, parseErrors } = makeRpc()
    rpc.handleLine(JSON.stringify({ id: 999, result: {} }))
    expect(parseErrors).toHaveLength(0)
  })
})

describe('DuplexRpc timeouts and disposal', () => {
  it('rejects with RpcTimeoutError after the timeout elapses', async () => {
    vi.useFakeTimers()
    const { rpc } = makeRpc()
    const p = rpc.request('slow', undefined, 5_000)
    const settled = p.then(
      () => null,
      (e: unknown) => e
    )
    await vi.advanceTimersByTimeAsync(4_999)
    expect(rpc.pendingCount).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    const err = await settled
    expect(err).toBeInstanceOf(RpcTimeoutError)
    expect(rpc.pendingCount).toBe(0)
  })

  it('a late reply after timeout is ignored without error', async () => {
    vi.useFakeTimers()
    const { rpc, written } = makeRpc()
    const p = rpc.request('slow', undefined, 10)
    const settled = p.then(
      () => 'resolved',
      () => 'rejected'
    )
    await vi.advanceTimersByTimeAsync(11)
    const id = JSON.parse(written[0]!).id as number
    rpc.handleLine(JSON.stringify({ id, result: 'too late' }))
    expect(await settled).toBe('rejected')
  })

  it('dispose rejects all pending requests and blocks new ones', async () => {
    const { rpc } = makeRpc()
    const p = rpc.request('m', undefined, 0)
    rpc.dispose('test teardown')
    await expect(p).rejects.toBeInstanceOf(RpcDisposedError)
    await expect(rpc.request('after')).rejects.toBeInstanceOf(RpcDisposedError)
    expect(rpc.isDisposed).toBe(true)
  })

  it('rejects when write throws', async () => {
    const rpc = new DuplexRpc({
      write: () => {
        throw new Error('socket gone')
      }
    })
    await expect(rpc.request('m')).rejects.toThrow('socket gone')
    expect(rpc.pendingCount).toBe(0)
  })
})

describe('DuplexRpc peer dispatch', () => {
  it('routes peer requests (method + id) to onPeerRequest', () => {
    const { rpc, peerRequests } = makeRpc()
    rpc.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 'req-1', method: 'pty.spawn', params: { sessionId: 's' } }))
    expect(peerRequests).toEqual([{ method: 'pty.spawn', params: { sessionId: 's' }, id: 'req-1' }])
  })

  it('routes notifications (method, no id) to onNotification', () => {
    const { rpc, notifications, peerRequests } = makeRpc()
    rpc.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'pty.data', params: { seq: 1 } }))
    expect(notifications).toEqual([{ method: 'pty.data', params: { seq: 1 } }])
    expect(peerRequests).toHaveLength(0)
  })

  it('auto-answers -32601 when no onPeerRequest handler is installed', () => {
    const written: string[] = []
    const rpc = new DuplexRpc({ write: (line) => written.push(line) })
    rpc.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'anything' }))
    expect(written).toHaveLength(1)
    const reply = JSON.parse(written[0]!)
    expect(reply.id).toBe(7)
    expect(reply.error.code).toBe(-32601)
  })

  it('respond / respondError emit well-formed JSON-RPC frames', () => {
    const { rpc, written } = makeRpc()
    rpc.respond('a', { ok: true })
    rpc.respondError('b', -32001, 'unimplemented: x', { hint: 'later' })
    expect(JSON.parse(written[0]!)).toEqual({ jsonrpc: '2.0', id: 'a', result: { ok: true } })
    expect(JSON.parse(written[1]!)).toEqual({
      jsonrpc: '2.0',
      id: 'b',
      error: { code: -32001, message: 'unimplemented: x', data: { hint: 'later' } }
    })
  })

  it('notify omits the id', () => {
    const { rpc, written } = makeRpc()
    rpc.notify('pty.data', { seq: 3 })
    const frame = JSON.parse(written[0]!)
    expect(frame).toEqual({ jsonrpc: '2.0', method: 'pty.data', params: { seq: 3 } })
    expect('id' in frame).toBe(false)
  })
})

describe('DuplexRpc malformed frames', () => {
  it.each([
    ['not json at all', 'garbage{'],
    ['a bare string', JSON.stringify('hello')],
    ['an array', JSON.stringify([1, 2])],
    ['an object with neither method nor result/error', JSON.stringify({ foo: 'bar' })]
  ])('routes %s to onParseError without throwing', (_label, line) => {
    const { rpc, parseErrors, peerRequests, notifications } = makeRpc()
    expect(() => rpc.handleLine(line)).not.toThrow()
    expect(parseErrors).toHaveLength(1)
    expect(peerRequests).toHaveLength(0)
    expect(notifications).toHaveLength(0)
  })

  it('ignores empty and whitespace-only lines', () => {
    const { rpc, parseErrors } = makeRpc()
    rpc.handleLine('')
    rpc.handleLine('   \t ')
    expect(parseErrors).toHaveLength(0)
  })
})

describe('LineDecoder', () => {
  it('reassembles lines across chunk boundaries', () => {
    const decoder = new LineDecoder()
    expect(decoder.feed('{"a":')).toEqual([])
    expect(decoder.feed('1}\n{"b":2}\n{"c"')).toEqual(['{"a":1}', '{"b":2}'])
    expect(decoder.feed(':3}')).toEqual([])
    expect(decoder.flush()).toBe('{"c":3}')
    expect(decoder.flush()).toBeNull()
  })
})
