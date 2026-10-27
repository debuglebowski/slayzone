/**
 * Tests for CodexChatSession — handshake, turn dispatch, notification →
 * AgentEvent translation, streaming bridge. Drives the driver through the
 * captured `simple-turn.ndjson` fixture.
 */
import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { codexChatBackend } from './codex-chat-session'
import type { AgentEvent } from '../../../shared/agent-events'
import type { ChatDriverContext, ChatSessionDriver, PermissionDecision } from '../types'

const flush = (): Promise<void> => new Promise((r) => setImmediate(r))

/** The Codex driver implements the optional control + permission seams; the tests drive them. */
type CodexDriver = ChatSessionDriver &
  Required<Pick<ChatSessionDriver, 'applyControl' | 'respondPermission'>>

function hasControlSeams(d: ChatSessionDriver): d is CodexDriver {
  return typeof d.applyControl === 'function' && typeof d.respondPermission === 'function'
}

/** Required by the `ChatSessionDriver` signature; Codex's applyControl ignores it. */
const CONTROL_TIMEOUT_MS = 1_000

interface Harness {
  driver: CodexDriver
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
    chatCollaboration: null,
    chatFastMode: false,
    ...ctxOverrides
  }
  const driver = codexChatBackend.createDriver()
  if (!hasControlSeams(driver))
    throw new Error('codex driver must implement applyControl + respondPermission')
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
    join(
      process.cwd(),
      'packages/domains/terminal/test/fixtures/codex-app-server/simple-turn.ndjson'
    ),
    'utf8'
  )
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l.includes('"method"'))
}

describe('CodexChatSession', () => {
  test('handshake: initialize then thread/start, emits turn-init', async () => {
    const h = makeHarness()
    await handshake(h, 'thread-abc')
    eqMethod(h.sent[0], 'initialize')
    expect(
      h.sent.some((m) => m.method === 'initialized'),
      'expected initialized notification'
    ).toBe(true)
    eqMethod(h.sent[2], 'thread/start')
    const turnInit = h.emitted.find((e) => e.kind === 'turn-init')
    expect(turnInit, 'expected turn-init event').not.toBe(undefined)
    expect(
      turnInit!.kind === 'turn-init' && turnInit!.sessionId === 'thread-abc',
      'turn-init.sessionId should be the thread id'
    ).toBeTruthy()
  })

  test('resume: uses thread/resume when ctx.resume is set', async () => {
    const h = makeHarness({ resume: true, sessionId: 'prior-thread' })
    await flush()
    h.driver.handleLine(JSON.stringify({ id: 1, result: { userAgent: 'x', codexHome: '/h' } }))
    await flush()
    eqMethod(h.sent[2], 'thread/resume')
    expect(
      (h.sent[2].params as Record<string, unknown>).threadId,
      'thread/resume should carry the stored thread id'
    ).toBe('prior-thread')
  })

  test('resume failure: emits a stderr marker the transport can detect', async () => {
    const h = makeHarness({ resume: true, sessionId: 'gone-thread' })
    await flush()
    h.driver.handleLine(JSON.stringify({ id: 1, result: { userAgent: 'x', codexHome: '/h' } }))
    await flush()
    h.driver.handleLine(
      JSON.stringify({ id: 2, error: { code: -32001, message: 'thread not found' } })
    )
    await flush()
    const stderr = h.emitted.find((e) => e.kind === 'stderr')
    expect(stderr, 'expected stderr event on resume failure').not.toBe(undefined)
    expect(
      stderr!.kind === 'stderr' && /no conversation found/i.test(stderr!.text),
      'stderr text must match detectResumeFailure pattern'
    ).toBeTruthy()
  })

  test('a failed fresh thread/start surfaces a fatal error event', async () => {
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
    expect(
      err !== undefined && err.kind === 'error' && /server overloaded/.test(err.message),
      'a fresh thread/start failure must surface as an error event, not throw away'
    ).toBeTruthy()
    // The fatal marker tells the transport to tear the session down.
    expect(
      err!.kind === 'error' && (err!.detail as { fatal?: unknown }).fatal === true,
      'a handshake failure must be marked detail.fatal'
    ).toBeTruthy()
    // It must NOT look like a resume failure — that would trigger a pointless respawn.
    expect(
      h.emitted.some((e) => e.kind === 'stderr'),
      'a fresh-start failure is not a resume failure'
    ).toBe(false)
  })

  test('a failed initialize surfaces a fatal error and sends no thread request', async () => {
    const h = makeHarness()
    await flush()
    // initialize (id 1) fails outright — the handshake cannot even begin.
    h.driver.handleLine(
      JSON.stringify({ id: 1, error: { code: -32000, message: 'app-server unavailable' } })
    )
    await flush()
    const err = h.emitted.find((e) => e.kind === 'error')
    expect(
      err !== undefined && err.kind === 'error' && /app-server unavailable/.test(err.message),
      'an initialize failure must surface as an error event'
    ).toBeTruthy()
    expect(
      err!.kind === 'error' && (err!.detail as { fatal?: unknown }).fatal === true,
      'an initialize failure must be marked detail.fatal'
    ).toBeTruthy()
    expect(
      h.sent.some((m) => m.method === 'thread/start' || m.method === 'thread/resume'),
      'no thread request should follow a failed initialize'
    ).toBe(false)
  })

  test('sendUserMessage issues turn/start with the prompt', async () => {
    const h = makeHarness()
    await handshake(h)
    h.driver.sendUserMessage('hello codex')
    const turnStart = h.sent.find((m) => m.method === 'turn/start')
    expect(turnStart, 'expected turn/start request').not.toBe(undefined)
    const params = turnStart!.params as { input: { text: string }[] }
    expect(params.input[0].text).toEqual('hello codex')
  })

  test('messages sent before handshake are queued and flushed', async () => {
    const h = makeHarness()
    // Send BEFORE feeding any handshake responses.
    h.driver.sendUserMessage('early message')
    await handshake(h)
    await flush()
    const turnStart = h.sent.find((m) => m.method === 'turn/start')
    expect(turnStart, 'queued message should flush into a turn/start').not.toBe(undefined)
  })

  test('full turn: fixture stream → assistant streaming events + result', async () => {
    const h = makeHarness()
    await handshake(h, '019e4a93-9480-7280-8300-f9507263082e')
    h.driver.sendUserMessage('Reply with exactly the two characters: OK')
    // turn/start response (id 3).
    h.driver.handleLine(JSON.stringify({ id: 3, result: { turn: { id: 'turn-1' } } }))
    for (const line of fixtureNotifications()) h.driver.handleLine(line)

    const kinds = h.emitted.map((e) => e.kind)
    // The agentMessage item must bridge onto the streaming-block events.
    expect(kinds, 'expected stream-message-start').toContain('stream-message-start')
    expect(kinds, 'expected stream-block-start').toContain('stream-block-start')
    expect(kinds, 'expected stream-block-delta').toContain('stream-block-delta')
    expect(kinds, 'expected stream-block-stop').toContain('stream-block-stop')
    expect(kinds, 'expected stream-message-stop').toContain('stream-message-stop')
    // The delta text must carry the model's reply.
    const delta = h.emitted.find((e) => e.kind === 'stream-block-delta')
    expect(
      delta!.kind === 'stream-block-delta' && delta!.text === 'OK',
      'delta text should be "OK"'
    ).toBeTruthy()
    // turn/completed must produce exactly one result so the in-flight counter balances.
    const results = h.emitted.filter((e) => e.kind === 'result')
    expect(results.length).toEqual(1)
    expect(
      results[0].kind === 'result' && !results[0].isError,
      'result should not be an error'
    ).toBeTruthy()
    // userMessage item echo must be dropped (transport emits its own user-message).
    expect(
      h.emitted.some((e) => e.kind === 'user-message'),
      'driver must not emit user-message (transport owns it)'
    ).toBe(false)
  })

  test('token usage from the fixture is folded into the result event', async () => {
    const h = makeHarness()
    await handshake(h, '019e4a93-9480-7280-8300-f9507263082e')
    h.driver.sendUserMessage('hi')
    h.driver.handleLine(JSON.stringify({ id: 3, result: { turn: { id: 'turn-1' } } }))
    for (const line of fixtureNotifications()) h.driver.handleLine(line)
    const result = h.emitted.find((e) => e.kind === 'result')
    expect(
      result!.kind === 'result' && result!.usage.inputTokens === 13446,
      'result.usage should carry the last token breakdown'
    ).toBeTruthy()
  })

  test('turn/plan/updated → agent-plan event with steps + explanation', async () => {
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
    expect(plan, 'expected agent-plan event').not.toBe(undefined)
    expect(
      plan!.kind === 'agent-plan' && plan!.steps.length === 2,
      'expected 2 plan steps'
    ).toBeTruthy()
    expect(
      plan!.kind === 'agent-plan' && plan!.explanation === 'breaking it down',
      'expected explanation'
    ).toBeTruthy()
  })

  test('reasoning item with no delta emits no empty stream block', async () => {
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
    expect(streamEvents.length, `expected no stream events, got ${streamEvents.length}`).toBe(0)
  })

  test('reasoning delta opens the stream lazily', async () => {
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
    expect(kinds, 'delta should open the stream').toContain('stream-message-start')
    const delta = h.emitted.find((e) => e.kind === 'stream-block-delta')
    expect(
      delta!.kind === 'stream-block-delta' && delta!.deltaType === 'thinking',
      'reasoning delta should be a thinking block'
    ).toBeTruthy()
  })

  test('extractSessionId returns the thread id from turn-init', async () => {
    const h = makeHarness()
    await handshake(h, 'thread-xyz')
    const turnInit = h.emitted.find((e) => e.kind === 'turn-init')!
    expect(h.driver.extractSessionId(turnInit)).toEqual('thread-xyz')
    expect(h.driver.extractSessionId({ kind: 'stderr', text: 'x' })).toEqual(null)
  })

  // ---- runtime policy mapping ----

  test('thread/start carries the approval + sandbox for each mode', async () => {
    const restricted = makeHarness({ chatMode: 'approval-required' })
    await handshake(restricted)
    const p1 = restricted.sent[2].params as Record<string, unknown>
    expect(p1.approvalPolicy, 'approval-required → untrusted').toEqual('untrusted')
    expect(p1.sandbox, 'approval-required → read-only').toEqual('read-only')

    const full = makeHarness({ chatMode: 'full-access' })
    await handshake(full)
    const p2 = full.sent[2].params as Record<string, unknown>
    expect(p2.approvalPolicy, 'full-access → never').toEqual('never')
    expect(p2.sandbox, 'full-access → danger-full-access').toEqual('danger-full-access')

    const dflt = makeHarness({ chatMode: 'auto-accept-edits' })
    await handshake(dflt)
    const p3 = dflt.sent[2].params as Record<string, unknown>
    expect(p3.approvalPolicy, 'auto-accept-edits → on-request').toEqual('on-request')
    expect(p3.sandbox, 'auto-accept-edits → workspace-write').toEqual('workspace-write')
  })

  test('turn/start carries the sandboxPolicy object for the mode', async () => {
    const h = makeHarness({ chatMode: 'approval-required' })
    await handshake(h)
    h.driver.sendUserMessage('go')
    const turn = h.sent.find((m) => m.method === 'turn/start')!
    const sp = (turn.params as Record<string, unknown>).sandboxPolicy as Record<string, unknown>
    expect(sp.type, 'approval-required → readOnly sandboxPolicy').toEqual('readOnly')
  })

  test('turn/start includes a codex model but omits a non-codex one', async () => {
    const codex = makeHarness({ chatModel: 'gpt-5.5' })
    await handshake(codex)
    codex.driver.sendUserMessage('go')
    const t1 = codex.sent.find((m) => m.method === 'turn/start')!
    expect((t1.params as Record<string, unknown>).model, 'codex model passes through').toEqual(
      'gpt-5.5'
    )

    const claude = makeHarness({ chatModel: 'sonnet' })
    await handshake(claude)
    claude.driver.sendUserMessage('go')
    const t2 = claude.sent.find((m) => m.method === 'turn/start')!
    expect((t2.params as Record<string, unknown>).model, 'non-codex model is dropped').toEqual(
      undefined
    )
  })

  test('turn/start maps reasoning effort (max → xhigh, unknown dropped)', async () => {
    const max = makeHarness({ chatEffort: 'max' })
    await handshake(max)
    max.driver.sendUserMessage('go')
    const t1 = max.sent.find((m) => m.method === 'turn/start')!
    expect((t1.params as Record<string, unknown>).effort, 'max clamps to xhigh').toEqual('xhigh')

    const bogus = makeHarness({ chatEffort: 'banana' })
    await handshake(bogus)
    bogus.driver.sendUserMessage('go')
    const t2 = bogus.sent.find((m) => m.method === 'turn/start')!
    expect((t2.params as Record<string, unknown>).effort, 'unknown effort is dropped').toEqual(
      undefined
    )
  })

  // ---- applyControl ----

  test('applyControl interrupt issues turn/interrupt with thread + turn id', async () => {
    const h = makeHarness()
    await handshake(h, 'thread-i')
    h.driver.sendUserMessage('go')
    h.driver.handleLine(JSON.stringify({ id: 3, result: { turn: { id: 'turn-i' } } }))
    await flush()
    void h.driver.applyControl({ subtype: 'interrupt' }, CONTROL_TIMEOUT_MS)
    const interrupt = h.sent.find((m) => m.method === 'turn/interrupt')
    expect(interrupt, 'expected a turn/interrupt request').not.toBe(undefined)
    expect(interrupt!.params).toEqual({ threadId: 'thread-i', turnId: 'turn-i' })
  })

  test('applyControl interrupt with no active turn sends nothing', async () => {
    const h = makeHarness()
    await handshake(h)
    await h.driver.applyControl({ subtype: 'interrupt' }, CONTROL_TIMEOUT_MS)
    expect(
      h.sent.some((m) => m.method === 'turn/interrupt'),
      'no turn/interrupt should be sent without an active turn'
    ).toBe(false)
  })

  test('applyControl set_model takes effect on the next turn', async () => {
    const h = makeHarness()
    await handshake(h)
    const ack = await h.driver.applyControl(
      { subtype: 'set_model', model: 'gpt-6-codex' },
      CONTROL_TIMEOUT_MS
    )
    expect(ack, 'set_model acks ok').toEqual({ ok: true })
    h.driver.sendUserMessage('go')
    const turn = h.sent.find((m) => m.method === 'turn/start')!
    expect((turn.params as Record<string, unknown>).model, 'next turn uses the new model').toEqual(
      'gpt-6-codex'
    )
  })

  test('applyControl set_effort takes effect on the next turn', async () => {
    const h = makeHarness()
    await handshake(h)
    await h.driver.applyControl({ subtype: 'set_effort', effort: 'high' }, CONTROL_TIMEOUT_MS)
    h.driver.sendUserMessage('go')
    const turn = h.sent.find((m) => m.method === 'turn/start')!
    expect(
      (turn.params as Record<string, unknown>).effort,
      'next turn uses the new effort'
    ).toEqual('high')
  })

  test('applyControl set_permission_mode changes the next turn sandbox', async () => {
    const h = makeHarness({ chatMode: 'full-access' })
    await handshake(h)
    await h.driver.applyControl(
      { subtype: 'set_permission_mode', mode: 'approval-required' },
      CONTROL_TIMEOUT_MS
    )
    h.driver.sendUserMessage('go')
    const turn = h.sent.find((m) => m.method === 'turn/start')!
    const sp = (turn.params as Record<string, unknown>).sandboxPolicy as Record<string, unknown>
    expect(sp.type, 'mode change flips the sandbox policy').toEqual('readOnly')
  })

  // ---- approvals / server requests ----

  test('a server approval request emits a permission-request event', async () => {
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
    expect(perm, 'expected a permission-request event').not.toBe(undefined)
    expect(
      perm!.kind === 'permission-request' &&
        perm!.requestId === '50' &&
        perm!.toolUseId === 'cmd-7',
      'permission-request should carry the request id + item id'
    ).toBeTruthy()
  })

  test('respondPermission allow replies with accept', async () => {
    const h = makeHarness()
    await handshake(h)
    h.driver.handleLine(
      JSON.stringify({ id: 51, method: 'execCommandApproval', params: { itemId: 'x' } })
    )
    const allowed = h.driver.respondPermission({
      requestId: '51',
      decision: { behavior: 'allow' } as PermissionDecision
    })
    expect(allowed, 'respondPermission should report success for a known request').toBeTruthy()
    const reply = h.sent.find((m) => m.id === 51)
    expect(reply, 'expected a JSON-RPC reply for id 51').not.toBe(undefined)
    expect((reply!.result as Record<string, unknown>).decision, 'allow → accept').toEqual('accept')
  })

  test('respondPermission deny replies with decline', async () => {
    const h = makeHarness()
    await handshake(h)
    h.driver.handleLine(JSON.stringify({ id: 52, method: 'applyPatchApproval', params: {} }))
    h.driver.respondPermission({
      requestId: '52',
      decision: { behavior: 'deny', message: 'no' } as PermissionDecision
    })
    const reply = h.sent.find((m) => m.id === 52)!
    expect((reply.result as Record<string, unknown>).decision, 'deny → decline').toEqual('decline')
  })

  test('respondPermission for an unknown request returns false', async () => {
    const h = makeHarness()
    await handshake(h)
    const ok = h.driver.respondPermission({
      requestId: 'nope',
      decision: { behavior: 'allow' } as PermissionDecision
    })
    expect(ok, 'an unknown request id must return false').toBe(false)
  })

  test('an unknown server request is declined with method-not-found', async () => {
    const h = makeHarness()
    await handshake(h)
    h.driver.handleLine(JSON.stringify({ id: 60, method: 'some/unknownRequest', params: {} }))
    const reply = h.sent.find((m) => m.id === 60)
    expect(reply, 'expected an error reply for the unknown request').not.toBe(undefined)
    expect((reply!.error as Record<string, unknown>).code, 'should reply method-not-found').toEqual(
      -32601
    )
    expect(
      h.emitted.some((e) => e.kind === 'permission-request'),
      'an unknown request must not emit a permission-request'
    ).toBe(false)
  })

  // ---- tool items ----

  test('tool-ish item/started events become tool-call events', async () => {
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
    expect(calls.length, 'expected 4 tool-call events').toEqual(4)
    const name = (id: string): string | undefined => {
      const c = calls.find((e) => e.kind === 'tool-call' && e.id === id)
      return c && c.kind === 'tool-call' ? c.name : undefined
    }
    expect(name('c1')).toEqual('codex/commandExecution')
    expect(name('f1')).toEqual('codex/fileChange')
    expect(name('w1')).toEqual('codex/webSearch')
    expect(name('m1'), 'mcp tool name is mcp/<server>/<tool>').toEqual('mcp/srv/lookup')
  })

  test('a completed tool item becomes a tool-result with the right error flag', async () => {
    const h = makeHarness()
    await handshake(h)
    const completed = (item: Record<string, unknown>): void =>
      h.driver.handleLine(
        JSON.stringify({ method: 'item/completed', params: { item, threadId: 't', turnId: 'tn' } })
      )
    completed({
      type: 'commandExecution',
      id: 'ok1',
      status: 'completed',
      aggregatedOutput: 'done'
    })
    completed({ type: 'commandExecution', id: 'bad1', status: 'failed', aggregatedOutput: 'boom' })

    const results = h.emitted.filter((e) => e.kind === 'tool-result')
    expect(results.length, 'expected 2 tool-result events').toEqual(2)
    const ok = results.find((r) => r.kind === 'tool-result' && r.toolUseId === 'ok1')!
    const bad = results.find((r) => r.kind === 'tool-result' && r.toolUseId === 'bad1')!
    expect(
      ok.kind === 'tool-result' && !ok.isError && ok.rawContent === 'done',
      'a completed command is not an error and carries its output'
    ).toBeTruthy()
    expect(
      bad.kind === 'tool-result' && bad.isError,
      'a failed command is flagged as an error'
    ).toBeTruthy()
  })

  // ---- turn lifecycle + errors ----

  test('turn/completed interrupted → result subtype interrupted, not an error', async () => {
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
    expect(
      result.kind === 'result' && result.subtype === 'interrupted',
      'subtype should be interrupted'
    ).toBeTruthy()
    expect(result.kind === 'result' && !result.isError, 'an interrupt is not an error').toBeTruthy()
  })

  test('turn/completed failed → result subtype error', async () => {
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
    expect(
      result.kind === 'result' && result.subtype === 'error',
      'failed → subtype error'
    ).toBeTruthy()
    expect(result.kind === 'result' && result.isError, 'failed → isError').toBeTruthy()
  })

  test('an error notification emits an error event', async () => {
    const h = makeHarness()
    await handshake(h)
    h.driver.handleLine(
      JSON.stringify({
        method: 'error',
        params: {
          error: { message: 'rate limited' },
          willRetry: false,
          threadId: 't',
          turnId: 'tn'
        }
      })
    )
    const err = h.emitted.find((e) => e.kind === 'error')
    expect(
      err !== undefined && err.kind === 'error' && err.message === 'rate limited',
      'the error message must be bridged'
    ).toBeTruthy()
  })

  test('a rejected turn/start emits an error and a balancing result', async () => {
    const h = makeHarness()
    await handshake(h)
    h.driver.sendUserMessage('go')
    h.driver.handleLine(JSON.stringify({ id: 3, error: { code: -1, message: 'turn boom' } }))
    await flush()
    const err = h.emitted.find((e) => e.kind === 'error')
    expect(
      err !== undefined && err.kind === 'error' && /turn boom/.test(err.message),
      'a turn failure must surface as an error event'
    ).toBeTruthy()
    const result = h.emitted.find((e) => e.kind === 'result')
    expect(
      result !== undefined && result.kind === 'result' && result.isError,
      'a failed result must balance the in-flight counter'
    ).toBeTruthy()
  })

  test('turn/started notification sets the turn id used by interrupt', async () => {
    const h = makeHarness()
    await handshake(h, 'thread-s')
    h.driver.sendUserMessage('go')
    // No turn/start reply fed — only the streamed turn/started notification.
    h.driver.handleLine(
      JSON.stringify({
        method: 'turn/started',
        params: { threadId: 't', turn: { id: 'turn-streamed' } }
      })
    )
    void h.driver.applyControl({ subtype: 'interrupt' }, CONTROL_TIMEOUT_MS)
    const interrupt = h.sent.find((m) => m.method === 'turn/interrupt')!
    expect(
      (interrupt.params as Record<string, unknown>).turnId,
      'interrupt should target the streamed turn id'
    ).toEqual('turn-streamed')
  })

  test('a disposed driver ignores further notifications', async () => {
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
    expect(h.emitted.length, 'no events should emit after dispose').toEqual(before)
  })

  test('turn/completed closes an open streaming block', async () => {
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
    expect(kinds, 'the open block should be stopped').toContain('stream-block-stop')
    expect(kinds, 'the open message should be stopped').toContain('stream-message-stop')
    expect(
      kinds.indexOf('stream-message-stop'),
      'the stream must close before the result'
    ).toBeLessThan(kinds.indexOf('result'))
  })

  test('switching modality closes the prior stream before opening the next', async () => {
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
    expect(firstStop, 'the first (text) stream must be closed').not.toBe(-1)
    expect(
      secondStart,
      'the second (thinking) stream opens after the first closes'
    ).toBeGreaterThan(firstStop)
  })
})

function eqMethod(msg: Record<string, unknown> | undefined, method: string): void {
  expect(msg, `expected a message with method ${method}`).not.toBe(undefined)
  expect(msg!.method, 'method mismatch').toEqual(method)
}
