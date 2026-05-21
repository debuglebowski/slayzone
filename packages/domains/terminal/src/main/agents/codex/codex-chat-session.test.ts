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
import type { ChatDriverContext } from '../types'

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
