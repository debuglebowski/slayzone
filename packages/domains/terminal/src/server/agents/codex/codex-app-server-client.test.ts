/**
 * Tests for CodexAppServerClient — JSON-RPC framing, id correlation,
 * server-request dispatch, timeout, disposal.
 * Run with: npx tsx packages/domains/terminal/src/main/agents/codex/codex-app-server-client.test.ts
 */
import { CodexAppServerClient, CodexRpcError, type JsonRpcId } from './codex-app-server-client'

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}`)
    console.error(`    ${e}`)
    failed++
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

function eq<T>(actual: T, expected: T, msg?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg ?? 'mismatch'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

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

async function run(): Promise<void> {
  console.log('\nCodexAppServerClient tests\n')

  await test('request writes a jsonrpc envelope with monotonic id', () => {
    const { client, sent } = makeClient()
    void client.request('initialize', { foo: 1 })
    void client.request('thread/start', { cwd: '/x' })
    eq(JSON.parse(sent[0]), { jsonrpc: '2.0', id: 1, method: 'initialize', params: { foo: 1 } })
    eq(JSON.parse(sent[1]), { jsonrpc: '2.0', id: 2, method: 'thread/start', params: { cwd: '/x' } })
  })

  await test('request omits params key when undefined', () => {
    const { client, sent } = makeClient()
    void client.request('account/logout')
    eq(JSON.parse(sent[0]), { jsonrpc: '2.0', id: 1, method: 'account/logout' })
  })

  await test('response (no jsonrpc field) resolves the pending request by id', async () => {
    const { client } = makeClient()
    const p = client.request<{ ok: boolean }>('initialize')
    // Codex responses omit the `jsonrpc` field — must still correlate.
    client.handleLine(JSON.stringify({ id: 1, result: { ok: true } }))
    eq(await p, { ok: true })
  })

  await test('error response rejects with CodexRpcError carrying code', async () => {
    const { client } = makeClient()
    const p = client.request('thread/resume')
    client.handleLine(JSON.stringify({ id: 1, error: { code: -32001, message: 'thread not found' } }))
    let caught: unknown
    try {
      await p
    } catch (e) {
      caught = e
    }
    assert(caught instanceof CodexRpcError, 'expected CodexRpcError')
    eq((caught as CodexRpcError).code, -32001)
    eq((caught as CodexRpcError).message, 'thread not found')
  })

  await test('out-of-order responses correlate to the right request', async () => {
    const { client } = makeClient()
    const a = client.request<string>('a')
    const b = client.request<string>('b')
    client.handleLine(JSON.stringify({ id: 2, result: 'B' }))
    client.handleLine(JSON.stringify({ id: 1, result: 'A' }))
    eq(await a, 'A')
    eq(await b, 'B')
  })

  await test('notification (method, no id) routes to onNotification', () => {
    let got: { m: string; p: unknown } | null = null
    const { client } = makeClient({ onNotification: (m, p) => (got = { m, p }) })
    client.handleLine(JSON.stringify({ method: 'turn/started', params: { threadId: 't1' } }))
    assert(got !== null, 'onNotification not called')
    eq(got!, { m: 'turn/started', p: { threadId: 't1' } })
  })

  await test('server request (method + id) routes to onServerRequest', () => {
    let got: { m: string; p: unknown; id: JsonRpcId } | null = null
    const { client } = makeClient({ onServerRequest: (m, p, id) => (got = { m, p, id }) })
    client.handleLine(
      JSON.stringify({ method: 'item/commandExecution/requestApproval', id: 7, params: { cmd: 'ls' } })
    )
    assert(got !== null, 'onServerRequest not called')
    eq(got!.m, 'item/commandExecution/requestApproval')
    eq(got!.id, 7)
  })

  await test('respond / respondError write id-matched replies', () => {
    const { client, sent } = makeClient()
    client.respond(7, { decision: 'approved' })
    client.respondError('abc', -32000, 'nope')
    eq(JSON.parse(sent[0]), { jsonrpc: '2.0', id: 7, result: { decision: 'approved' } })
    eq(JSON.parse(sent[1]), { jsonrpc: '2.0', id: 'abc', error: { code: -32000, message: 'nope' } })
  })

  await test('malformed line goes to onParseError, never throws', () => {
    let errLine: string | null = null
    const { client } = makeClient({ onParseError: (line) => (errLine = line) })
    client.handleLine('{not json')
    eq(errLine, '{not json')
    client.handleLine('   ') // blank — ignored, no error
  })

  await test('request times out and rejects', async () => {
    const { client } = makeClient()
    const p = client.request('slow', undefined, 20)
    let caught: unknown
    try {
      await p
    } catch (e) {
      caught = e
    }
    assert(caught instanceof Error, 'expected timeout error')
    assert(String(caught).includes('timed out'), 'expected timeout message')
  })

  await test('dispose rejects all pending requests', async () => {
    const { client } = makeClient()
    const p = client.request('initialize', undefined, 0)
    client.dispose()
    let caught: unknown
    try {
      await p
    } catch (e) {
      caught = e
    }
    assert(caught instanceof Error, 'expected rejection')
    assert(String(caught).includes('closed'), 'expected closed message')
  })

  await test('request after dispose rejects immediately', async () => {
    const { client } = makeClient()
    client.dispose()
    let caught: unknown
    try {
      await client.request('initialize')
    } catch (e) {
      caught = e
    }
    assert(caught instanceof Error, 'expected rejection')
  })

  await test('a throwing write (dead subprocess stdin) rejects the request', async () => {
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
    assert(caught instanceof Error, 'a write failure must reject the request promise')
    assert(String(caught).includes('EPIPE'), 'the underlying write error should propagate')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

void run()
