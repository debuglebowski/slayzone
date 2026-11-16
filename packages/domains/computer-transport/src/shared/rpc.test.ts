import { afterEach, describe, expect, it, vi } from 'vitest'
import { DuplexRpc, LineDecoder, RpcDisposedError, RpcError, RpcTimeoutError } from './rpc'
import { COMPUTER_FRAME_MAX_BYTES, FRAME_TOO_LARGE_CODE } from './frame-limit'
import { ComputerTransportErrorCodes } from './frames'

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

describe('request abort over the existing duplex connection', () => {
  it('cancels only its own live peer request and removes its local waiter', async () => {
    const signals = new Map<string, AbortSignal>()
    let client!: DuplexRpc
    const peer = new DuplexRpc({
      write: (line) => client.handleLine(line),
      onPeerRequest(method, _params, _id, _actor, signal) {
        signals.set(method, signal)
      }
    })
    client = new DuplexRpc({ write: (line) => peer.handleLine(line) })
    const abort = new AbortController()
    const one = client.request('one', {}, 0, undefined, abort.signal)
    const two = client.request('two', {}, 0)
    void one.catch(() => undefined)
    void two.catch(() => undefined)
    try {
      expect(signals.get('one')).toBeDefined()
      abort.abort()
      await expect(one).rejects.toMatchObject({ name: 'AbortError' })
      expect(signals.get('one')?.aborted).toBe(true)
      expect(signals.get('two')?.aborted).toBe(false)
      expect(client.pendingCount).toBe(1)
      peer.respond(2, 'kept')
      expect(await two).toBe('kept')
      expect(client.pendingCount).toBe(0)
    } finally {
      client.dispose()
      peer.dispose()
    }
  })

  it('never sends an already aborted request or a cancellation after its reply', async () => {
    const { rpc, written } = makeRpc()
    const aborted = new AbortController()
    aborted.abort()
    try {
      await expect(rpc.request('absent', {}, 0, undefined, aborted.signal)).rejects.toMatchObject({
        name: 'AbortError'
      })
      expect(written).toHaveLength(0)
      const late = new AbortController()
      const completed = rpc.request('complete', {}, 0, undefined, late.signal)
      const id = JSON.parse(written[0]).id
      rpc.handleLine(JSON.stringify({ id, result: true }))
      expect(await completed).toBe(true)
      late.abort()
      expect(written).toHaveLength(1)
    } finally {
      rpc.dispose()
    }
  })

  it('disposal aborts accepted inbound work while its owner remains responsible for cleanup', () => {
    let signal: AbortSignal | undefined
    const { rpc } = makeRpc({
      onPeerRequest(_m, _p, _id, _actor, current) {
        signal = current
      }
    })
    try {
      rpc.handleLine(JSON.stringify({ id: 'accepted', method: 'write' }))
      expect(signal).toBeDefined()
      expect(signal?.aborted).toBe(false)
      rpc.dispose()
      expect(signal?.aborted).toBe(true)
    } finally {
      rpc.dispose()
    }
  })
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
    rpc.handleLine(
      JSON.stringify({ id, error: { code: -32001, message: 'unimplemented: m', data: { x: 1 } } })
    )
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

  it('a request in flight when the host sleeps is not timed out by the sleep', async () => {
    // Lid closed 5s after the request went out; 42 minutes later the host wakes.
    // Electron's node on macOS counts sleep, so the 30s deadline fires on wake: the
    // peer (asleep too) never had a chance to answer. Seen live as
    // "computer-hub request 'chat.request' timed out after 30000ms" after a sleep.
    vi.useFakeTimers()
    const t0 = Date.now()
    const wake = t0 + 5_000 + 42 * 60_000
    const slept = (): number => Math.max(0, Math.min(Date.now(), wake) - (t0 + 5_000))
    const { rpc, written } = makeRpc({
      suspendClock: () => ({
        lastResumeAt: () => (Date.now() >= wake ? wake : 0),
        awakeNow: () => Date.now() - slept(),
        dispose: () => undefined
      })
    })
    const p = rpc.request('chat.request', undefined, 30_000)
    await vi.advanceTimersByTimeAsync(wake - t0 + 1_000)
    expect(rpc.pendingCount).toBe(1)
    const id = JSON.parse(written[0]!).id as number
    rpc.handleLine(JSON.stringify({ id, result: 'answered after wake' }))
    await expect(p).resolves.toBe('answered after wake')
  })

  it('a peer still silent after a sleep times out once the window has passed awake', async () => {
    vi.useFakeTimers()
    const t0 = Date.now()
    const wake = t0 + 5_000 + 42 * 60_000
    const slept = (): number => Math.max(0, Math.min(Date.now(), wake) - (t0 + 5_000))
    const { rpc } = makeRpc({
      suspendClock: () => ({
        lastResumeAt: () => (Date.now() >= wake ? wake : 0),
        awakeNow: () => Date.now() - slept(),
        dispose: () => undefined
      })
    })
    const settled = rpc.request('slow', undefined, 30_000).then(
      () => null,
      (e: unknown) => e
    )
    // 5s awake before the sleep + 24.999s after it: still inside the window.
    await vi.advanceTimersByTimeAsync(wake - t0 + 24_999)
    expect(rpc.pendingCount).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await settled).toBeInstanceOf(RpcTimeoutError)
    expect(rpc.pendingCount).toBe(0)
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
    rpc.handleLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'req-1',
        method: 'pty.spawn',
        params: { sessionId: 's' }
      })
    )
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

describe('DuplexRpc frame limit (send side)', () => {
  const LIMIT = 1024
  type Info = Parameters<
    NonNullable<ConstructorParameters<typeof DuplexRpc>[0]['onFrameTooLarge']>
  >[0]
  function capped(overrides: Partial<ConstructorParameters<typeof DuplexRpc>[0]> = {}) {
    const tooLarge: Info[] = []
    const h = makeRpc({
      maxFrameBytes: LIMIT,
      onFrameTooLarge: (info) => tooLarge.push(info),
      ...overrides
    })
    return { ...h, tooLarge }
  }
  const frameBytes = (line: string): number => Buffer.byteLength(line, 'utf8')

  it('defaults to the shared computer frame limit', () => {
    expect(COMPUTER_FRAME_MAX_BYTES).toBe(100 * 1024 * 1024)
    expect(FRAME_TOO_LARGE_CODE).toBe(-32008)
    expect(ComputerTransportErrorCodes.frameTooLarge).toBe(FRAME_TOO_LARGE_CODE)
    expect(new DuplexRpc({ write: () => undefined }).maxFrameBytes).toBe(COMPUTER_FRAME_MAX_BYTES)
  })

  it('an oversized reply becomes a frameTooLarge error for that id, naming method and sizes', () => {
    const { rpc, written, peerRequests, tooLarge } = capped()
    rpc.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'chat.request', params: {} }))
    expect(peerRequests).toHaveLength(1)
    rpc.respond(9, { blob: 'x'.repeat(5000) })
    expect(written).toHaveLength(1)
    const reply = JSON.parse(written[0]!)
    expect(reply.id).toBe(9)
    expect(reply.result).toBeUndefined()
    expect(reply.error.code).toBe(FRAME_TOO_LARGE_CODE)
    expect(reply.error.message).toContain("'chat.request'")
    expect(reply.error.message).toContain(String(LIMIT))
    expect(reply.error.data).toMatchObject({ method: 'chat.request', limitBytes: LIMIT })
    expect(reply.error.data.bytes).toBeGreaterThan(5000)
    expect(frameBytes(written[0]!)).toBeLessThanOrEqual(LIMIT)
    expect(tooLarge).toEqual([
      expect.objectContaining({
        kind: 'response',
        method: 'chat.request',
        id: 9,
        limitBytes: LIMIT
      })
    ])
  })

  it('measures UTF-8 bytes, not characters', () => {
    const { rpc, written, tooLarge } = capped()
    // ~400 chars but ~1200 bytes ('é' = 2 bytes, '€' = 3 bytes).
    rpc.respond('a', { s: '€'.repeat(400) })
    expect(JSON.parse(written[0]!).error.code).toBe(FRAME_TOO_LARGE_CODE)
    expect(tooLarge).toHaveLength(1)
  })

  it('a frame of exactly the limit is sent', () => {
    const { rpc, written, tooLarge } = capped()
    const overhead = JSON.stringify({ jsonrpc: '2.0', id: 'a', result: { s: '' } }).length
    rpc.respond('a', { s: 'y'.repeat(LIMIT - overhead) })
    expect(frameBytes(written[0]!)).toBe(LIMIT)
    expect(JSON.parse(written[0]!).result.s).toHaveLength(LIMIT - overhead)
    expect(tooLarge).toHaveLength(0)
  })

  it('an oversized error reply keeps its code and message, dropping only its data', () => {
    const { rpc, written, tooLarge } = capped()
    rpc.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 'a', method: 'exec.run' }))
    rpc.respondError('a', -32000, 'boom', { dump: 'z'.repeat(5000) })
    const reply = JSON.parse(written[0]!)
    expect(reply.error.code).toBe(-32000)
    expect(reply.error.message).toMatch(/^boom/)
    expect(reply.error.message).toContain('error data omitted')
    expect(reply.error.data).toBeUndefined()
    expect(frameBytes(written[0]!)).toBeLessThanOrEqual(LIMIT)
    expect(tooLarge).toEqual([expect.objectContaining({ kind: 'response', method: 'exec.run' })])
  })

  it('an oversized error message is truncated, code kept', () => {
    const { rpc, written } = capped()
    rpc.respondError('a', -32006, `refused: ${'m'.repeat(5000)}`)
    const reply = JSON.parse(written[0]!)
    expect(reply.error.code).toBe(-32006)
    expect(reply.error.message).toMatch(/^refused: m+/)
    expect(reply.error.message).toContain('truncated')
    expect(frameBytes(written[0]!)).toBeLessThanOrEqual(LIMIT)
  })

  it('an error reply that cannot be slimmed under the limit falls back to frameTooLarge', () => {
    const { rpc, written } = capped()
    // The id alone (echoed by every reply) leaves no room for the original error.
    const id = 'i'.repeat(LIMIT)
    rpc.respondError(id, -32000, 'boom', { dump: 'z'.repeat(5000) })
    const reply = JSON.parse(written[0]!)
    expect(reply.id).toBe(id)
    expect(reply.error.code).toBe(FRAME_TOO_LARGE_CODE)
  })

  it('a reply too large to serialize at all becomes frameTooLarge, not a throw', () => {
    const { rpc, written, tooLarge } = capped()
    const huge = {
      toJSON() {
        throw new RangeError('Invalid string length')
      }
    }
    expect(() => rpc.respond('a', huge)).not.toThrow()
    const reply = JSON.parse(written[0]!)
    expect(reply.error.code).toBe(FRAME_TOO_LARGE_CODE)
    expect(reply.error.data).toMatchObject({ bytes: null, limitBytes: LIMIT })
    expect(tooLarge[0]).toMatchObject({ kind: 'response', bytes: null })
  })

  it('a reply that cannot be serialized for another reason becomes an internal error', () => {
    const { rpc, written } = capped()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => rpc.respond('a', cyclic)).not.toThrow()
    const reply = JSON.parse(written[0]!)
    expect(reply.error.code).toBe(-32000)
    expect(reply.error.message).toContain('could not be serialized')
  })

  it('an oversized request is rejected locally and never sent', async () => {
    const { rpc, written, tooLarge } = capped()
    const err = await rpc.request('fs.writeFile', { content: 'w'.repeat(5000) }).then(
      () => null,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(RpcError)
    expect((err as RpcError).code).toBe(FRAME_TOO_LARGE_CODE)
    expect((err as RpcError).message).toContain("'fs.writeFile'")
    expect((err as RpcError).data).toMatchObject({ method: 'fs.writeFile', limitBytes: LIMIT })
    expect(written).toHaveLength(0)
    expect(rpc.pendingCount).toBe(0)
    expect(tooLarge).toEqual([expect.objectContaining({ kind: 'request', method: 'fs.writeFile' })])
    // The endpoint keeps working.
    const ok = rpc.request('small')
    expect(written).toHaveLength(1)
    rpc.handleLine(JSON.stringify({ id: JSON.parse(written[0]!).id, result: 1 }))
    await expect(ok).resolves.toBe(1)
  })

  it('a request whose params cannot be serialized rejects instead of throwing synchronously', async () => {
    const { rpc } = capped()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    let p: Promise<unknown> | undefined
    expect(() => {
      p = rpc.request('m', cyclic)
    }).not.toThrow()
    await expect(p).rejects.toThrow()
    expect(rpc.pendingCount).toBe(0)
  })

  it('an oversized notification is dropped with a diagnostic, never thrown', () => {
    const { rpc, written, tooLarge } = capped()
    expect(() => rpc.notify('event', { payload: 'e'.repeat(5000) })).not.toThrow()
    expect(written).toHaveLength(0)
    expect(tooLarge).toEqual([expect.objectContaining({ kind: 'notification', method: 'event' })])
    rpc.notify('pty.data', { seq: 1 })
    expect(written).toHaveLength(1)
  })

  it('maxFrameBytes <= 0 disables the cap', () => {
    const { rpc, written } = makeRpc({ maxFrameBytes: 0 })
    rpc.respond('a', { s: 'q'.repeat(5000) })
    expect(JSON.parse(written[0]!).result.s).toHaveLength(5000)
  })

  it('describeRequest names an envelope request by what it carries', async () => {
    const describe = (method: string, params: unknown): string =>
      method === 'dispatch' ? String((params as { method: string }).method) : method
    const { rpc, written, tooLarge } = capped({ describeRequest: describe })
    // Inbound: a reply too large for an enveloped request names the inner method.
    rpc.handleLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'dispatch',
        params: { method: 'chat.request' }
      })
    )
    rpc.respond(1, { history: 'h'.repeat(5000) })
    const reply = JSON.parse(written[0]!)
    expect(reply.error.code).toBe(FRAME_TOO_LARGE_CODE)
    expect(reply.error.message).toContain("'chat.request'")
    expect(reply.error.message).not.toContain('dispatch')
    expect(reply.error.data.method).toBe('chat.request')
    // Outbound: the same for a request refused locally, and for pendingMethods.
    const err = await rpc
      .request('dispatch', { method: 'fs.writeFile', params: { content: 'w'.repeat(5000) } })
      .then(
        () => null,
        (e: unknown) => e
      )
    expect((err as RpcError).message).toContain("request 'fs.writeFile'")
    expect(tooLarge.map((t) => t.method)).toEqual(['chat.request', 'fs.writeFile'])
    rpc.request('dispatch', { method: 'pty.list' }, 0).catch(() => undefined)
    expect(rpc.pendingMethods()).toEqual(['pty.list'])
    rpc.dispose()
  })

  it('pendingMethods lists in-flight outbound request methods', () => {
    const { rpc, written } = makeRpc()
    rpc.request('alpha', undefined, 0).catch(() => undefined)
    rpc.request('beta', undefined, 0).catch(() => undefined)
    expect(rpc.pendingMethods()).toEqual(['alpha', 'beta'])
    rpc.handleLine(JSON.stringify({ id: JSON.parse(written[0]!).id, result: null }))
    expect(rpc.pendingMethods()).toEqual(['beta'])
    rpc.dispose()
  })
})
