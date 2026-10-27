/**
 * Tests for CodexAppServerClient — JSON-RPC framing, id correlation,
 * server-request dispatch, timeout, disposal.
 */
import { describe, expect, test } from 'vitest'
import { CodexAppServerClient, CodexRpcError, type JsonRpcId } from './codex-app-server-client'

/** Build a client whose writes are captured into `sent`. */
function makeClient(
  overrides: Partial<{
    onNotification: (m: string, p: unknown) => void
    onServerRequest: (m: string, p: unknown, id: JsonRpcId) => void
    onParseError: (line: string, err: unknown) => void
  }> = {}
): { client: CodexAppServerClient; sent: string[] } {
  const sent: string[] = []
  const client = new CodexAppServerClient({
    write: (line) => sent.push(line),
    ...overrides
  })
  return { client, sent }
}

describe('CodexAppServerClient', () => {
  test('request writes a jsonrpc envelope with monotonic id', () => {
    const { client, sent } = makeClient()
    void client.request('initialize', { foo: 1 })
    void client.request('thread/start', { cwd: '/x' })
    expect(JSON.parse(sent[0])).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { foo: 1 }
    })
    expect(JSON.parse(sent[1])).toEqual({
      jsonrpc: '2.0',
      id: 2,
      method: 'thread/start',
      params: { cwd: '/x' }
    })
  })

  test('request omits params key when undefined', () => {
    const { client, sent } = makeClient()
    void client.request('account/logout')
    expect(JSON.parse(sent[0])).toEqual({ jsonrpc: '2.0', id: 1, method: 'account/logout' })
  })

  test('response (no jsonrpc field) resolves the pending request by id', async () => {
    const { client } = makeClient()
    const p = client.request<{ ok: boolean }>('initialize')
    // Codex responses omit the `jsonrpc` field — must still correlate.
    client.handleLine(JSON.stringify({ id: 1, result: { ok: true } }))
    expect(await p).toEqual({ ok: true })
  })

  test('error response rejects with CodexRpcError carrying code', async () => {
    const { client } = makeClient()
    const p = client.request('thread/resume')
    client.handleLine(
      JSON.stringify({ id: 1, error: { code: -32001, message: 'thread not found' } })
    )
    let caught: unknown
    try {
      await p
    } catch (e) {
      caught = e
    }
    expect(caught, 'expected CodexRpcError').toBeInstanceOf(CodexRpcError)
    expect((caught as CodexRpcError).code).toEqual(-32001)
    expect((caught as CodexRpcError).message).toEqual('thread not found')
  })

  test('out-of-order responses correlate to the right request', async () => {
    const { client } = makeClient()
    const a = client.request<string>('a')
    const b = client.request<string>('b')
    client.handleLine(JSON.stringify({ id: 2, result: 'B' }))
    client.handleLine(JSON.stringify({ id: 1, result: 'A' }))
    expect(await a).toEqual('A')
    expect(await b).toEqual('B')
  })

  test('notification (method, no id) routes to onNotification', () => {
    let got: { m: string; p: unknown } | null = null
    const { client } = makeClient({ onNotification: (m, p) => (got = { m, p }) })
    client.handleLine(JSON.stringify({ method: 'turn/started', params: { threadId: 't1' } }))
    expect(got, 'onNotification not called').not.toBe(null)
    expect(got!).toEqual({ m: 'turn/started', p: { threadId: 't1' } })
  })

  test('server request (method + id) routes to onServerRequest', () => {
    let got: { m: string; p: unknown; id: JsonRpcId } | null = null
    const { client } = makeClient({ onServerRequest: (m, p, id) => (got = { m, p, id }) })
    client.handleLine(
      JSON.stringify({
        method: 'item/commandExecution/requestApproval',
        id: 7,
        params: { cmd: 'ls' }
      })
    )
    expect(got, 'onServerRequest not called').not.toBe(null)
    expect(got!.m).toEqual('item/commandExecution/requestApproval')
    expect(got!.id).toEqual(7)
  })

  test('respond / respondError write id-matched replies', () => {
    const { client, sent } = makeClient()
    client.respond(7, { decision: 'approved' })
    client.respondError('abc', -32000, 'nope')
    expect(JSON.parse(sent[0])).toEqual({ jsonrpc: '2.0', id: 7, result: { decision: 'approved' } })
    expect(JSON.parse(sent[1])).toEqual({
      jsonrpc: '2.0',
      id: 'abc',
      error: { code: -32000, message: 'nope' }
    })
  })

  test('malformed line goes to onParseError, never throws', () => {
    let errLine: string | null = null
    const { client } = makeClient({ onParseError: (line) => (errLine = line) })
    client.handleLine('{not json')
    expect(errLine).toEqual('{not json')
    client.handleLine('   ') // blank — ignored, no error
  })

  test('request times out and rejects', async () => {
    const { client } = makeClient()
    const p = client.request('slow', undefined, 20)
    let caught: unknown
    try {
      await p
    } catch (e) {
      caught = e
    }
    expect(caught, 'expected timeout error').toBeInstanceOf(Error)
    expect(String(caught), 'expected timeout message').toContain('timed out')
  })

  test('dispose rejects all pending requests', async () => {
    const { client } = makeClient()
    const p = client.request('initialize', undefined, 0)
    client.dispose()
    let caught: unknown
    try {
      await p
    } catch (e) {
      caught = e
    }
    expect(caught, 'expected rejection').toBeInstanceOf(Error)
    expect(String(caught), 'expected closed message').toContain('closed')
  })

  test('request after dispose rejects immediately', async () => {
    const { client } = makeClient()
    client.dispose()
    let caught: unknown
    try {
      await client.request('initialize')
    } catch (e) {
      caught = e
    }
    expect(caught, 'expected rejection').toBeInstanceOf(Error)
  })

  test('a throwing write (dead subprocess stdin) rejects the request', async () => {
    const client = new CodexAppServerClient({
      write: () => {
        throw new Error('EPIPE: write to a closed stream')
      }
    })
    let caught: unknown
    try {
      await client.request('initialize')
    } catch (e) {
      caught = e
    }
    expect(caught, 'a write failure must reject the request promise').toBeInstanceOf(Error)
    expect(String(caught), 'the underlying write error should propagate').toContain('EPIPE')
  })
})
