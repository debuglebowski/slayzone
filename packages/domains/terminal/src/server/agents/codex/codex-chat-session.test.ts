/**
 * Tests for CodexChatSession — handshake, turn dispatch, notification →
 * AgentEvent translation, streaming bridge. Drives the driver through the
 * captured `simple-turn.ndjson` fixture.
 * Run with: npx tsx packages/domains/terminal/src/main/agents/codex/codex-chat-session.test.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { codexChatBackend } from './codex-chat-session'
import type { AgentEvent } from '../../../shared/agent-events'
import type { ChatDriverContext, PermissionDecision } from '../types'

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? e.stack : e}`)
    failed++
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r))

interface Harness {
  driver: ReturnType<typeof codexChatBackend.createDriver>
  sent: Record<string, unknown>[]
  emitted: AgentEvent[]
}

function makeHarness(ctxOverrides: Partial<ChatDriverContext> = {}): Harness {
  const sent: Record<string, unknown>[] = []
  const emitted: AgentEvent[] = []
  const ctx: ChatDriverContext = {
    write: (line) => sent.push(JSON.parse(line)),
    emit: (event) => emitted.push(event),
    cwd: '/work',
    sessionId: '',
    resume: false,
    providerFlags: [],
    chatModel: null,
    chatEffort: null,
    chatMode: 'full-access',
    ...ctxOverrides
  }
  const driver = codexChatBackend.createDriver()
  void driver.start(ctx)
  return { driver, sent, emitted }
}

/** Run the initialize → thread/start handshake, returning once turn-init emits. */
async function handshake(h: Harness, threadId = 'thread-1'): Promise<void> {
  await flush()
  // sent[0] = initialize request
  h.driver.handleLine(JSON.stringify({ id: 1, result: { userAgent: 'x', codexHome: '/h' } }))
  await flush()
  // driver sent `initialized` notify + thread/start (id 2)
  h.driver.handleLine(
    JSON.stringify({
      id: 2,
      result: { thread: { id: threadId }, model: 'gpt-5.5', cwd: '/work' }
    })
  )
  await flush()
}

/** Fixture notification lines (the `method`-bearing turn stream). */
function fixtureNotifications(): string[] {
  const raw = readFileSync(
    join(process.cwd(), 'packages/domains/terminal/test/fixtures/codex-app-server/simple-turn.ndjson'),
    'utf8'
  )
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l.includes('"method"'))
}

async function run(): Promise<void> {
  console.log('\nCodexChatSession tests\n')

  await test('handshake: initialize then thread/start, emits turn-init', async () => {
    const h = makeHarness()
    await handshake(h, 'thread-abc')
    eqMethod(h.sent[0], 'initialize')
    assert(
      h.sent.some((m) => m.method === 'initialized'),
      'expected initialized notification'
    )
    eqMethod(h.sent[2], 'thread/start')
    const turnInit = h.emitted.find((e) => e.kind === 'turn-init')
    assert(turnInit !== undefined, 'expected turn-init event')
    assert(
      turnInit!.kind === 'turn-init' && turnInit!.sessionId === 'thread-abc',
      'turn-init.sessionId should be the thread id'
    )
  })

  await test('resume: uses thread/resume when ctx.resume is set', async () => {
    const h = makeHarness({ resume: true, sessionId: 'prior-thread' })
    await flush()
    h.driver.handleLine(JSON.stringify({ id: 1, result: { userAgent: 'x', codexHome: '/h' } }))
    await flush()
    eqMethod(h.sent[2], 'thread/resume')
    assert(
      (h.sent[2].params as Record<string, unknown>).threadId === 'prior-thread',
      'thread/resume should carry the stored thread id'
    )
  })

  await test('resume failure: emits a stderr marker the transport can detect', async () => {
    const h = makeHarness({ resume: true, sessionId: 'gone-thread' })
    await flush()
    h.driver.handleLine(JSON.stringify({ id: 1, result: { userAgent: 'x', codexHome: '/h' } }))
    await flush()
    h.driver.handleLine(
      JSON.stringify({ id: 2, error: { code: -32001, message: 'thread not found' } })
    )
    await flush()
    const stderr = h.emitted.find((e) => e.kind === 'stderr')
    assert(stderr !== undefined, 'expected stderr event on resume failure')
    assert(
      stderr!.kind === 'stderr' && /no conversation found/i.test(stderr!.text),
      'stderr text must match detectResumeFailure pattern'
    )
  })

  await test('a failed fresh thread/start surfaces a fatal error event', async () => {
    const h = makeHarness()
    await flush()
    // initialize succeeds...
    h.driver.handleLine(JSON.stringify({ id: 1, result: { userAgent: 'x', codexHome: '/h' } }))
    await flush()
    // ...but thread/start (id 2) fails.
    h.driver.handleLine(
      JSON.stringify({ id: 2, error: { code: -32000, message: 'server overloaded' } })
    )
    await flush()
    const err = h.emitted.find((e) => e.kind === 'error')
    assert(
      err !== undefined && err.kind === 'error' && /server overloaded/.test(err.message),
      'a fresh thread/start failure must surface as an error event, not throw away'
    )
    // The fatal marker tells the transport to tear the session down.
    assert(
      err!.kind === 'error' && (err!.detail as { fatal?: unknown }).fatal === true,
      'a handshake failure must be marked detail.fatal'
    )
    // It must NOT look like a resume failure — that would trigger a pointless respawn.
    assert(
      !h.emitted.some((e) => e.kind === 'stderr'),
      'a fresh-start failure is not a resume failure'
    )
  })

  await test('a failed initialize surfaces a fatal error and sends no thread request', async () => {
    const h = makeHarness()
    await flush()
    // initialize (id 1) fails outright — the handshake cannot even begin.
    h.driver.handleLine(
      JSON.stringify({ id: 1, error: { code: -32000, message: 'app-server unavailable' } })
    )
    await flush()
    const err = h.emitted.find((e) => e.kind === 'error')
    assert(
      err !== undefined && err.kind === 'error' && /app-server unavailable/.test(err.message),
      'an initialize failure must surface as an error event'
    )
    assert(
      err!.kind === 'error' && (err!.detail as { fatal?: unknown }).fatal === true,
      'an initialize failure must be marked detail.fatal'
    )
    assert(
      !h.sent.some((m) => m.method === 'thread/start' || m.method === 'thread/resume'),
      'no thread request should follow a failed initialize'
    )
  })

  await test('sendUserMessage issues turn/start with the prompt', async () => {
    const h = makeHarness()
    await handshake(h)
    h.driver.sendUserMessage('hello codex')
    const turnStart = h.sent.find((m) => m.method === 'turn/start')
    assert(turnStart !== undefined, 'expected turn/start request')
    const params = turnStart!.params as { input: { text: string }[] }
    eq(params.input[0].text, 'hello codex')
  })

  await test('messages sent before handshake are queued and flushed', async () => {
    const h = makeHarness()
    // Send BEFORE feeding any handshake responses.
    h.driver.sendUserMessage('early message')
    await handshake(h)
    await flush()
    const turnStart = h.sent.find((m) => m.method === 'turn/start')
    assert(turnStart !== undefined, 'queued message should flush into a turn/start')
  })

  await test('full turn: fixture stream → assistant streaming events + result', async () => {
    const h = makeHarness()
    await handshake(h, '019e4a93-9480-7280-8300-f9507263082e')
    h.driver.sendUserMessage('Reply with exactly the two characters: OK')
    // turn/start response (id 3).
    h.driver.handleLine(JSON.stringify({ id: 3, result: { turn: { id: 'turn-1' } } }))
    for (const line of fixtureNotifications()) h.driver.handleLine(line)

    const kinds = h.emitted.map((e) => e.kind)
    // The agentMessage item must bridge onto the streaming-block events.
    assert(kinds.includes('stream-message-start'), 'expected stream-message-start')
    assert(kinds.includes('stream-block-start'), 'expected stream-block-start')
    assert(kinds.includes('stream-block-delta'), 'expected stream-block-delta')
    assert(kinds.includes('stream-block-stop'), 'expected stream-block-stop')
    assert(kinds.includes('stream-message-stop'), 'expected stream-message-stop')
    // The delta text must carry the model's reply.
    const delta = h.emitted.find((e) => e.kind === 'stream-block-delta')
    assert(delta!.kind === 'stream-block-delta' && delta!.text === 'OK', 'delta text should be "OK"')
    // turn/completed must produce exactly one result so the in-flight counter balances.
    const results = h.emitted.filter((e) => e.kind === 'result')
    eq(results.length, 1)
    assert(results[0].kind === 'result' && !results[0].isError, 'result should not be an error')
    // userMessage item echo must be dropped (transport emits its own user-message).
    assert(
      !h.emitted.some((e) => e.kind === 'user-message'),
      'driver must not emit user-message (transport owns it)'
    )
  })

  await test('token usage from the fixture is folded into the result event', async () => {
    const h = makeHarness()
    await handshake(h, '019e4a93-9480-7280-8300-f9507263082e')
    h.driver.sendUserMessage('hi')
    h.driver.handleLine(JSON.stringify({ id: 3, result: { turn: { id: 'turn-1' } } }))
    for (const line of fixtureNotifications()) h.driver.handleLine(line)
    const result = h.emitted.find((e) => e.kind === 'result')
    assert(
      result!.kind === 'result' && result!.usage.inputTokens === 13446,
      'result.usage should carry the last token breakdown'
    )
  })

  await test('turn/plan/updated → agent-plan event with steps + explanation', async () => {
    const h = makeHarness()
    await handshake(h)
    h.driver.handleLine(
      JSON.stringify({
        method: 'turn/plan/updated',
        params: {
          threadId: 't',
          turnId: 'turn-1',
          explanation: 'breaking it down',
          plan: [
            { step: 'read code', status: 'completed' },
            { step: 'write fix', status: 'inProgress' }
          ]
        }
      })
    )
    const plan = h.emitted.find((e) => e.kind === 'agent-plan')
    assert(plan !== undefined, 'expected agent-plan event')
    assert(plan!.kind === 'agent-plan' && plan!.steps.length === 2, 'expected 2 plan steps')
    assert(
      plan!.kind === 'agent-plan' && plan!.explanation === 'breaking it down',
      'expected explanation'
    )
  })

  await test('reasoning item with no delta emits no empty stream block', async () => {
    const h = makeHarness()
    await handshake(h)
    const before = h.emitted.length
    // A reasoning item that starts and completes without ever emitting a delta
    // must NOT produce a stream-message/block pair — streams open lazily.
    h.driver.handleLine(
      JSON.stringify({
        method: 'item/started',
        params: { item: { type: 'reasoning', id: 'r1' }, threadId: 't', turnId: 'turn-1' }
      })
    )
    h.driver.handleLine(
      JSON.stringify({
        method: 'item/completed',
        params: { item: { type: 'reasoning', id: 'r1' }, threadId: 't', turnId: 'turn-1' }
      })
    )
    const streamEvents = h.emitted.slice(before).filter((e) => e.kind.startsWith('stream-'))
    assert(streamEvents.length === 0, `expected no stream events, got ${streamEvents.length}`)
  })

  await test('reasoning delta opens the stream lazily', async () => {
    const h = makeHarness()
    await handshake(h)
    h.driver.handleLine(
      JSON.stringify({
        method: 'item/started',
        params: { item: { type: 'reasoning', id: 'r2' }, threadId: 't', turnId: 'turn-1' }
      })
    )
    h.driver.handleLine(
      JSON.stringify({
        method: 'item/reasoning/textDelta',
        params: { threadId: 't', turnId: 'turn-1', itemId: 'r2', delta: 'hmm', contentIndex: 0 }
      })
    )
    const kinds = h.emitted.map((e) => e.kind)
    assert(kinds.includes('stream-message-start'), 'delta should open the stream')
    const delta = h.emitted.find((e) => e.kind === 'stream-block-delta')
    assert(
      delta!.kind === 'stream-block-delta' && delta!.deltaType === 'thinking',
      'reasoning delta should be a thinking block'
    )
  })

  await test('extractSessionId returns the thread id from turn-init', async () => {
    const h = makeHarness()
    await handshake(h, 'thread-xyz')
    const turnInit = h.emitted.find((e) => e.kind === 'turn-init')!
    eq(h.driver.extractSessionId(turnInit), 'thread-xyz')
    eq(h.driver.extractSessionId({ kind: 'stderr', text: 'x' }), null)
  })

  // ---- runtime policy mapping ----

  await test('thread/start carries the approval + sandbox for each mode', async () => {
    const restricted = makeHarness({ chatMode: 'approval-required' })
    await handshake(restricted)
    const p1 = restricted.sent[2].params as Record<string, unknown>
    eq(p1.approvalPolicy, 'untrusted', 'approval-required → untrusted')
    eq(p1.sandbox, 'read-only', 'approval-required → read-only')

    const full = makeHarness({ chatMode: 'full-access' })
    await handshake(full)
    const p2 = full.sent[2].params as Record<string, unknown>
    eq(p2.approvalPolicy, 'never', 'full-access → never')
    eq(p2.sandbox, 'danger-full-access', 'full-access → danger-full-access')

    const dflt = makeHarness({ chatMode: 'auto-accept-edits' })
    await handshake(dflt)
    const p3 = dflt.sent[2].params as Record<string, unknown>
    eq(p3.approvalPolicy, 'on-request', 'auto-accept-edits → on-request')
    eq(p3.sandbox, 'workspace-write', 'auto-accept-edits → workspace-write')
  })

  await test('turn/start carries the sandboxPolicy object for the mode', async () => {
    const h = makeHarness({ chatMode: 'approval-required' })
    await handshake(h)
    h.driver.sendUserMessage('go')
    const turn = h.sent.find((m) => m.method === 'turn/start')!
    const sp = (turn.params as Record<string, unknown>).sandboxPolicy as Record<string, unknown>
    eq(sp.type, 'readOnly', 'approval-required → readOnly sandboxPolicy')
  })

  await test('turn/start includes a codex model but omits a non-codex one', async () => {
    const codex = makeHarness({ chatModel: 'gpt-5.5' })
    await handshake(codex)
    codex.driver.sendUserMessage('go')
    const t1 = codex.sent.find((m) => m.method === 'turn/start')!
    eq((t1.params as Record<string, unknown>).model, 'gpt-5.5', 'codex model passes through')

    const claude = makeHarness({ chatModel: 'sonnet' })
    await handshake(claude)
    claude.driver.sendUserMessage('go')
    const t2 = claude.sent.find((m) => m.method === 'turn/start')!
    eq((t2.params as Record<string, unknown>).model, undefined, 'non-codex model is dropped')
  })

  await test('turn/start maps reasoning effort (max → xhigh, unknown dropped)', async () => {
    const max = makeHarness({ chatEffort: 'max' })
    await handshake(max)
    max.driver.sendUserMessage('go')
    const t1 = max.sent.find((m) => m.method === 'turn/start')!
    eq((t1.params as Record<string, unknown>).effort, 'xhigh', 'max clamps to xhigh')

    const bogus = makeHarness({ chatEffort: 'banana' })
    await handshake(bogus)
    bogus.driver.sendUserMessage('go')
    const t2 = bogus.sent.find((m) => m.method === 'turn/start')!
    eq((t2.params as Record<string, unknown>).effort, undefined, 'unknown effort is dropped')
  })

  // ---- applyControl ----

  await test('applyControl interrupt issues turn/interrupt with thread + turn id', async () => {
    const h = makeHarness()
    await handshake(h, 'thread-i')
    h.driver.sendUserMessage('go')
    h.driver.handleLine(JSON.stringify({ id: 3, result: { turn: { id: 'turn-i' } } }))
    await flush()
    void h.driver.applyControl({ subtype: 'interrupt' })
    const interrupt = h.sent.find((m) => m.method === 'turn/interrupt')
    assert(interrupt !== undefined, 'expected a turn/interrupt request')
    eq(interrupt!.params, { threadId: 'thread-i', turnId: 'turn-i' })
  })

  await test('applyControl interrupt with no active turn sends nothing', async () => {
    const h = makeHarness()
    await handshake(h)
    await h.driver.applyControl({ subtype: 'interrupt' })
    assert(
      !h.sent.some((m) => m.method === 'turn/interrupt'),
      'no turn/interrupt should be sent without an active turn'
    )
  })

  await test('applyControl set_model takes effect on the next turn', async () => {
    const h = makeHarness()
    await handshake(h)
    const ack = await h.driver.applyControl({ subtype: 'set_model', model: 'gpt-6-codex' })
    eq(ack, { ok: true }, 'set_model acks ok')
    h.driver.sendUserMessage('go')
    const turn = h.sent.find((m) => m.method === 'turn/start')!
    eq((turn.params as Record<string, unknown>).model, 'gpt-6-codex', 'next turn uses the new model')
  })

  await test('applyControl set_effort takes effect on the next turn', async () => {
    const h = makeHarness()
    await handshake(h)
    await h.driver.applyControl({ subtype: 'set_effort', effort: 'high' })
    h.driver.sendUserMessage('go')
    const turn = h.sent.find((m) => m.method === 'turn/start')!
    eq((turn.params as Record<string, unknown>).effort, 'high', 'next turn uses the new effort')
  })

  await test('applyControl set_permission_mode changes the next turn sandbox', async () => {
    const h = makeHarness({ chatMode: 'full-access' })
    await handshake(h)
    await h.driver.applyControl({ subtype: 'set_permission_mode', mode: 'approval-required' })
    h.driver.sendUserMessage('go')
    const turn = h.sent.find((m) => m.method === 'turn/start')!
    const sp = (turn.params as Record<string, unknown>).sandboxPolicy as Record<string, unknown>
    eq(sp.type, 'readOnly', 'mode change flips the sandbox policy')
  })

  // ---- approvals / server requests ----

  await test('a server approval request emits a permission-request event', async () => {
    const h = makeHarness()
    await handshake(h)
    h.driver.handleLine(
      JSON.stringify({
        id: 50,
        method: 'item/commandExecution/requestApproval',
        params: { itemId: 'cmd-7' }
      })
    )
    const perm = h.emitted.find((e) => e.kind === 'permission-request')
    assert(perm !== undefined, 'expected a permission-request event')
    assert(
      perm!.kind === 'permission-request' &&
        perm!.requestId === '50' &&
        perm!.toolUseId === 'cmd-7',
      'permission-request should carry the request id + item id'
    )
  })

  await test('respondPermission allow replies with accept', async () => {
    const h = makeHarness()
    await handshake(h)
    h.driver.handleLine(
      JSON.stringify({ id: 51, method: 'execCommandApproval', params: { itemId: 'x' } })
    )
    const allowed = h.driver.respondPermission({
      requestId: '51',
      decision: { behavior: 'allow' } as PermissionDecision
    })
    assert(allowed, 'respondPermission should report success for a known request')
    const reply = h.sent.find((m) => m.id === 51)
    assert(reply !== undefined, 'expected a JSON-RPC reply for id 51')
    eq((reply!.result as Record<string, unknown>).decision, 'accept', 'allow → accept')
  })

  await test('respondPermission deny replies with decline', async () => {
    const h = makeHarness()
    await handshake(h)
    h.driver.handleLine(JSON.stringify({ id: 52, method: 'applyPatchApproval', params: {} }))
    h.driver.respondPermission({
      requestId: '52',
      decision: { behavior: 'deny', message: 'no' } as PermissionDecision
    })
    const reply = h.sent.find((m) => m.id === 52)!
    eq((reply.result as Record<string, unknown>).decision, 'decline', 'deny → decline')
  })

  await test('respondPermission for an unknown request returns false', async () => {
    const h = makeHarness()
    await handshake(h)
    const ok = h.driver.respondPermission({
      requestId: 'nope',
      decision: { behavior: 'allow' } as PermissionDecision
    })
    assert(ok === false, 'an unknown request id must return false')
  })

  await test('an unknown server request is declined with method-not-found', async () => {
    const h = makeHarness()
    await handshake(h)
    h.driver.handleLine(JSON.stringify({ id: 60, method: 'some/unknownRequest', params: {} }))
    const reply = h.sent.find((m) => m.id === 60)
    assert(reply !== undefined, 'expected an error reply for the unknown request')
    eq((reply!.error as Record<string, unknown>).code, -32601, 'should reply method-not-found')
    assert(
      !h.emitted.some((e) => e.kind === 'permission-request'),
      'an unknown request must not emit a permission-request'
    )
  })

  // ---- tool items ----

  await test('tool-ish item/started events become tool-call events', async () => {
    const h = makeHarness()
    await handshake(h)
    const started = (item: Record<string, unknown>): void =>
      h.driver.handleLine(
        JSON.stringify({ method: 'item/started', params: { item, threadId: 't', turnId: 'tn' } })
      )
    started({ type: 'commandExecution', id: 'c1', command: 'ls -la', cwd: '/work' })
    started({ type: 'fileChange', id: 'f1', changes: [{ path: 'a.ts' }] })
    started({ type: 'webSearch', id: 'w1', query: 'codex' })
    started({ type: 'mcpToolCall', id: 'm1', server: 'srv', tool: 'lookup', arguments: { q: 1 } })

    const calls = h.emitted.filter((e) => e.kind === 'tool-call')
    eq(calls.length, 4, 'expected 4 tool-call events')
    const name = (id: string): string | undefined => {
      const c = calls.find((e) => e.kind === 'tool-call' && e.id === id)
      return c && c.kind === 'tool-call' ? c.name : undefined
    }
    eq(name('c1'), 'codex/commandExecution')
    eq(name('f1'), 'codex/fileChange')
    eq(name('w1'), 'codex/webSearch')
    eq(name('m1'), 'mcp/srv/lookup', 'mcp tool name is mcp/<server>/<tool>')
  })

  await test('a completed tool item becomes a tool-result with the right error flag', async () => {
    const h = makeHarness()
    await handshake(h)
    const completed = (item: Record<string, unknown>): void =>
      h.driver.handleLine(
        JSON.stringify({ method: 'item/completed', params: { item, threadId: 't', turnId: 'tn' } })
      )
    completed({ type: 'commandExecution', id: 'ok1', status: 'completed', aggregatedOutput: 'done' })
    completed({ type: 'commandExecution', id: 'bad1', status: 'failed', aggregatedOutput: 'boom' })

    const results = h.emitted.filter((e) => e.kind === 'tool-result')
    eq(results.length, 2, 'expected 2 tool-result events')
    const ok = results.find((r) => r.kind === 'tool-result' && r.toolUseId === 'ok1')!
    const bad = results.find((r) => r.kind === 'tool-result' && r.toolUseId === 'bad1')!
    assert(
      ok.kind === 'tool-result' && !ok.isError && ok.rawContent === 'done',
      'a completed command is not an error and carries its output'
    )
    assert(bad.kind === 'tool-result' && bad.isError, 'a failed command is flagged as an error')
  })

  // ---- turn lifecycle + errors ----

  await test('turn/completed interrupted → result subtype interrupted, not an error', async () => {
    const h = makeHarness()
    await handshake(h)
    h.driver.handleLine(
      JSON.stringify({
        method: 'turn/completed',
        params: {
          threadId: 't',
          turn: { id: 'tn', status: 'interrupted', error: null, durationMs: 5 }
        }
      })
    )
    const result = h.emitted.find((e) => e.kind === 'result')!
    assert(result.kind === 'result' && result.subtype === 'interrupted', 'subtype should be interrupted')
    assert(result.kind === 'result' && !result.isError, 'an interrupt is not an error')
  })

  await test('turn/completed failed → result subtype error', async () => {
    const h = makeHarness()
    await handshake(h)
    h.driver.handleLine(
      JSON.stringify({
        method: 'turn/completed',
        params: {
          threadId: 't',
          turn: { id: 'tn', status: 'failed', error: { message: 'x' }, durationMs: 1 }
        }
      })
    )
    const result = h.emitted.find((e) => e.kind === 'result')!
    assert(result.kind === 'result' && result.subtype === 'error', 'failed → subtype error')
    assert(result.kind === 'result' && result.isError, 'failed → isError')
  })

  await test('an error notification emits an error event', async () => {
    const h = makeHarness()
    await handshake(h)
    h.driver.handleLine(
      JSON.stringify({
        method: 'error',
        params: { error: { message: 'rate limited' }, willRetry: false, threadId: 't', turnId: 'tn' }
      })
    )
    const err = h.emitted.find((e) => e.kind === 'error')
    assert(
      err !== undefined && err.kind === 'error' && err.message === 'rate limited',
      'the error message must be bridged'
    )
  })

  await test('a rejected turn/start emits an error and a balancing result', async () => {
    const h = makeHarness()
    await handshake(h)
    h.driver.sendUserMessage('go')
    h.driver.handleLine(JSON.stringify({ id: 3, error: { code: -1, message: 'turn boom' } }))
    await flush()
    const err = h.emitted.find((e) => e.kind === 'error')
    assert(
      err !== undefined && err.kind === 'error' && /turn boom/.test(err.message),
      'a turn failure must surface as an error event'
    )
    const result = h.emitted.find((e) => e.kind === 'result')
    assert(
      result !== undefined && result.kind === 'result' && result.isError,
      'a failed result must balance the in-flight counter'
    )
  })

  await test('turn/started notification sets the turn id used by interrupt', async () => {
    const h = makeHarness()
    await handshake(h, 'thread-s')
    h.driver.sendUserMessage('go')
    // No turn/start reply fed — only the streamed turn/started notification.
    h.driver.handleLine(
      JSON.stringify({ method: 'turn/started', params: { threadId: 't', turn: { id: 'turn-streamed' } } })
    )
    void h.driver.applyControl({ subtype: 'interrupt' })
    const interrupt = h.sent.find((m) => m.method === 'turn/interrupt')!
    eq(
      (interrupt.params as Record<string, unknown>).turnId,
      'turn-streamed',
      'interrupt should target the streamed turn id'
    )
  })

  await test('a disposed driver ignores further notifications', async () => {
    const h = makeHarness()
    await handshake(h)
    h.driver.dispose()
    const before = h.emitted.length
    h.driver.handleLine(
      JSON.stringify({
        method: 'error',
        params: { error: { message: 'late' }, willRetry: false, threadId: 't', turnId: 'tn' }
      })
    )
    eq(h.emitted.length, before, 'no events should emit after dispose')
  })

  await test('turn/completed closes an open streaming block', async () => {
    const h = makeHarness()
    await handshake(h)
    h.driver.handleLine(
      JSON.stringify({
        method: 'item/agentMessage/delta',
        params: { threadId: 't', turnId: 'tn', itemId: 'a1', delta: 'hi' }
      })
    )
    h.driver.handleLine(
      JSON.stringify({
        method: 'turn/completed',
        params: {
          threadId: 't',
          turn: { id: 'tn', status: 'completed', error: null, durationMs: 1 }
        }
      })
    )
    const kinds = h.emitted.map((e) => e.kind)
    assert(kinds.includes('stream-block-stop'), 'the open block should be stopped')
    assert(kinds.includes('stream-message-stop'), 'the open message should be stopped')
    assert(
      kinds.indexOf('stream-message-stop') < kinds.indexOf('result'),
      'the stream must close before the result'
    )
  })

  await test('switching modality closes the prior stream before opening the next', async () => {
    const h = makeHarness()
    await handshake(h)
    h.driver.handleLine(
      JSON.stringify({
        method: 'item/agentMessage/delta',
        params: { threadId: 't', turnId: 'tn', itemId: 'a1', delta: 'text' }
      })
    )
    h.driver.handleLine(
      JSON.stringify({
        method: 'item/reasoning/textDelta',
        params: { threadId: 't', turnId: 'tn', itemId: 'r1', delta: 'think' }
      })
    )
    const kinds = h.emitted.map((e) => e.kind)
    const firstStop = kinds.indexOf('stream-message-stop')
    const secondStart = kinds.lastIndexOf('stream-message-start')
    assert(firstStop !== -1, 'the first (text) stream must be closed')
    assert(secondStart > firstStop, 'the second (thinking) stream opens after the first closes')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

function eq<T>(actual: T, expected: T, msg?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${msg ?? 'mismatch'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    )
  }
}
function eqMethod(msg: Record<string, unknown> | undefined, method: string): void {
  assert(msg !== undefined, `expected a message with method ${method}`)
  eq(msg!.method, method, 'method mismatch')
}

void run()
