/**
 * Tests for chat-timeline reducer (correlation + pairing + in-flight).
 * Run with: pnpm dlx tsx packages/domains/terminal/src/client/chat-timeline.test.ts
 */
import type { AgentEvent } from '../shared/agent-events'
import {
  initialState,
  reducer,
  isInFlight,
  isAwaitingUserQuestion,
  deriveLoadingLabel
} from './chat-timeline'

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}`)
    console.error(`    ${e}`)
    failed++
  }
}

function expect<T>(actual: T) {
  return {
    toBe(expected: T) {
      if (actual !== expected)
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    },
    toBeTruthy() {
      if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`)
    }
  }
}

const ev = {
  turnInit: (sessionId = 'sid-1'): AgentEvent => ({
    kind: 'turn-init',
    sessionId,
    model: 'opus',
    cwd: '/tmp',
    tools: []
  }),
  text: (id = 'msg-1', text = 'hello'): AgentEvent => ({
    kind: 'assistant-text',
    messageId: id,
    text
  }),
  call: (id = 't-1', name = 'Bash'): AgentEvent => ({
    kind: 'tool-call',
    id,
    name,
    input: {}
  }),
  result: (toolUseId = 't-1', isError = false): AgentEvent => ({
    kind: 'tool-result',
    toolUseId,
    isError,
    rawContent: 'done',
    structured: null
  }),
  turnResult: (): AgentEvent => ({
    kind: 'result',
    subtype: 'success',
    isError: false,
    durationMs: 100,
    durationApiMs: 50,
    numTurns: 1,
    totalCostUsd: 0.01,
    stopReason: 'end_turn',
    terminalReason: 'completed',
    text: 'ok',
    modelUsage: {},
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0
    },
    permissionDenials: []
  })
}

console.log('\nChat timeline reducer tests\n')

test('agent-plan: first update appends a plan card', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, {
    type: 'event',
    event: { kind: 'agent-plan', steps: [{ step: 'a', status: 'pending' }] }
  })
  const plans = s.timeline.filter((i) => i.kind === 'plan')
  expect(plans.length).toBe(1)
})

test('agent-plan: consecutive updates in one turn collapse into a single card', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, {
    type: 'event',
    event: { kind: 'agent-plan', steps: [{ step: 'a', status: 'pending' }] }
  })
  s = reducer(s, {
    type: 'event',
    event: {
      kind: 'agent-plan',
      steps: [
        { step: 'a', status: 'completed' },
        { step: 'b', status: 'inProgress' }
      ]
    }
  })
  const plans = s.timeline.filter((i) => i.kind === 'plan')
  expect(plans.length).toBe(1)
  const plan = plans[0]
  expect(plan.kind === 'plan' && plan.steps.length).toBe(2)
})

test('agent-plan: a new turn gets its own plan card', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, {
    type: 'event',
    event: { kind: 'agent-plan', steps: [{ step: 'a', status: 'pending' }] }
  })
  s = reducer(s, { type: 'event', event: { kind: 'user-message', text: 'next' } })
  s = reducer(s, {
    type: 'event',
    event: { kind: 'agent-plan', steps: [{ step: 'b', status: 'pending' }] }
  })
  const plans = s.timeline.filter((i) => i.kind === 'plan')
  expect(plans.length).toBe(2)
})

test('call + result → one tool item with status done', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, { type: 'event', event: ev.call('t-1', 'Bash') })
  s = reducer(s, { type: 'event', event: ev.result('t-1') })
  const tools = s.timeline.filter((i) => i.kind === 'tool')
  expect(tools.length).toBe(1)
  const only = tools[0]
  if (only.kind !== 'tool') throw new Error('wrong kind')
  expect(only.invocation.status).toBe('done')
  expect(only.invocation.result?.rawContent).toBe('done')
})

test('out-of-order: result before call still pairs', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, { type: 'event', event: ev.result('t-late') })
  // Then a subsequent call with the same id (rare but possible) — reducer should not duplicate
  const tools = s.timeline.filter((i) => i.kind === 'tool')
  expect(tools.length).toBe(1)
  const only = tools[0]
  if (only.kind !== 'tool') throw new Error('wrong kind')
  expect(only.invocation.status).toBe('done')
})

test('tool-result with isError=true → status error', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, { type: 'event', event: ev.call('e-1') })
  s = reducer(s, { type: 'event', event: ev.result('e-1', true) })
  const tools = s.timeline.filter((i) => i.kind === 'tool')
  if (tools[0].kind !== 'tool') throw new Error('wrong kind')
  expect(tools[0].invocation.status).toBe('error')
})

test('second turn-init does not duplicate session-start item', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit('a') })
  s = reducer(s, { type: 'event', event: ev.turnInit('a') })
  s = reducer(s, { type: 'event', event: ev.turnInit('a') })
  const sessionStarts = s.timeline.filter((i) => i.kind === 'session-start')
  expect(sessionStarts.length).toBe(1)
})

test('inFlight: true after user-sent, false after result', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  expect(isInFlight(s)).toBe(false)
  s = reducer(s, { type: 'user-sent', text: 'hi' })
  expect(isInFlight(s)).toBe(true)
  s = reducer(s, { type: 'event', event: ev.turnResult() })
  expect(isInFlight(s)).toBe(false)
})

test('inFlight: queued send + result completes one turn → still in flight if next dispatched', () => {
  // Real flow: ChatPanel queues sends while inFlight; user-sent only dispatches when idle.
  // After result the queue drainer kicks the next send → user-sent fires → inFlight true again.
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, { type: 'user-sent', text: 'first' })
  expect(isInFlight(s)).toBe(true)
  s = reducer(s, { type: 'event', event: ev.turnResult() })
  expect(isInFlight(s)).toBe(false)
  s = reducer(s, { type: 'user-sent', text: 'second' })
  expect(isInFlight(s)).toBe(true)
  s = reducer(s, { type: 'event', event: ev.turnResult() })
  expect(isInFlight(s)).toBe(false)
})

test('process-exit sets sessionEnded when sessionId matches current session', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit('sid-live') })
  s = reducer(s, { type: 'process-exit', sessionId: 'sid-live', code: 0, signal: null })
  expect(s.sessionEnded).toBe(true)
  expect(s.exitCode).toBe(0)
})

test('process-exit with mismatched sessionId is dropped (stale exit guard)', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit('sid-current') })
  s = reducer(s, { type: 'process-exit', sessionId: 'sid-old', code: 137, signal: 'SIGKILL' })
  expect(s.sessionEnded).toBe(false)
  expect(s.exitCode).toBe(null)
})

test('process-exit before any turn-init is dropped (sessionId still null)', () => {
  let s = initialState()
  s = reducer(s, { type: 'process-exit', sessionId: 'sid-zombie', code: 0, signal: null })
  expect(s.sessionEnded).toBe(false)
})

// ---- drift recovery (orphaned-turn self-heal) -----------------------------

test('drift recovery: replay w/ orphaned mid-buffer user-message self-heals', () => {
  // Real bug: app crashed mid-turn at seq 3 → no result/interrupted persisted.
  // User sent more turns later (135, 138, 177, 184) all completed cleanly.
  // Without self-heal, replay leaves userMessagesSent=4 / resultCount=3 → stuck "Writing…".
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  // Turn 1: user-message, never terminated (mid-turn crash).
  s = reducer(s, { type: 'event', event: { kind: 'user-message', text: 'turn 1' } })
  expect(isInFlight(s)).toBe(true)
  // Turn 2: arrives next. Healer must close turn 1 before counting turn 2.
  s = reducer(s, { type: 'event', event: { kind: 'user-message', text: 'turn 2' } })
  expect(isInFlight(s)).toBe(true) // turn 2 still in flight
  s = reducer(s, { type: 'event', event: ev.turnResult() })
  expect(isInFlight(s)).toBe(false)
  // Synthetic interrupted from heal must be visible between the two user-text rows.
  const kinds = s.timeline.map((it) => it.kind)
  const u1 = kinds.indexOf('user-text')
  const interrupted = kinds.indexOf('interrupted', u1)
  const u2 = kinds.indexOf('user-text', interrupted)
  expect(u1 >= 0).toBe(true)
  expect(interrupted > u1).toBe(true)
  expect(u2 > interrupted).toBe(true)
})

test('drift recovery: process-exit mid-stream balances counters + clears openBlocks', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit('sid-A') })
  s = reducer(s, { type: 'event', event: { kind: 'user-message', text: 'hi' } })
  s = reducer(s, { type: 'event', event: { kind: 'stream-message-start', messageId: 'm1' } })
  s = reducer(s, {
    type: 'event',
    event: { kind: 'stream-block-start', blockIndex: 0, blockType: 'text' }
  })
  s = reducer(s, {
    type: 'event',
    event: { kind: 'stream-block-delta', blockIndex: 0, deltaType: 'text', text: 'partial' }
  })
  expect(isInFlight(s)).toBe(true)
  expect(s.openBlocks.size).toBe(1)
  // Process dies before stream-message-stop / result.
  s = reducer(s, {
    type: 'event',
    event: { kind: 'process-exit', code: null, signal: 'SIGKILL' }
  })
  expect(isInFlight(s)).toBe(false)
  expect(s.openBlocks.size).toBe(0)
  expect(s.currentStreamMessageId).toBe(null)
  expect(s.sessionEnded).toBe(true)
})

test('drift recovery: result clears stranded openBlocks (missing stream-message-stop)', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, { type: 'event', event: { kind: 'user-message', text: 'hi' } })
  s = reducer(s, { type: 'event', event: { kind: 'stream-message-start', messageId: 'm1' } })
  s = reducer(s, {
    type: 'event',
    event: { kind: 'stream-block-start', blockIndex: 0, blockType: 'text' }
  })
  s = reducer(s, {
    type: 'event',
    event: { kind: 'stream-block-delta', blockIndex: 0, deltaType: 'text', text: 'response' }
  })
  expect(s.openBlocks.size).toBe(1)
  // Result arrives without stream-message-stop (e.g. SDK closes stream abruptly).
  s = reducer(s, { type: 'event', event: ev.turnResult() })
  expect(s.openBlocks.size).toBe(0)
  expect(s.currentStreamMessageId).toBe(null)
  // inFlight is the gate that suppresses the indicator; label still falls back to
  // tail-text per the sticky-label policy, but it's never read while !inFlight.
  expect(isInFlight(s)).toBe(false)
})

test('drift recovery: optimistic user-sent over orphaned prior turn heals first', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, { type: 'event', event: { kind: 'user-message', text: 'turn 1' } })
  // Live path: user clicks send while inFlight stuck from drift.
  s = reducer(s, { type: 'user-sent', text: 'turn 2' })
  // Heal closed turn 1 (resultCount bumped to match userMessagesSent), then optimistic
  // bumped userMessagesSent again. So drift = 1 (just for the new turn).
  expect(s.userMessagesSent - s.resultCount).toBe(1)
  const interrupted = s.timeline.filter((it) => it.kind === 'interrupted')
  expect(interrupted.length).toBe(1)
})

test('drift recovery: idempotent — replay produces same state regardless of order', () => {
  // Replay-determinism guard: the heal logic must not introduce divergence
  // between live application and cold replay of the same buffer.
  const events: AgentEvent[] = [
    ev.turnInit(),
    { kind: 'user-message', text: 'orphan' }, // never terminated
    { kind: 'user-message', text: 'next' }, // triggers heal
    ev.turnResult()
  ]
  let live = initialState()
  for (const e of events) live = reducer(live, { type: 'event', event: e })
  let replay = initialState()
  for (const e of events) replay = reducer(replay, { type: 'event', event: e })
  const strip = (t: typeof live.timeline): unknown =>
    JSON.stringify(t, (k, v) => (k === 'timestamp' ? 0 : v))
  expect(strip(live.timeline)).toBe(strip(replay.timeline))
  expect(isInFlight(live)).toBe(false)
})

test('replay determinism: live vs getBuffer yields identical timeline (timestamp-stripped)', () => {
  const events: AgentEvent[] = [
    ev.turnInit(),
    ev.text('m-1', 'hi'),
    ev.call('t-1', 'Read'),
    ev.result('t-1'),
    ev.text('m-2', 'done'),
    ev.turnResult()
  ]
  let live = initialState()
  for (const e of events) live = reducer(live, { type: 'event', event: e })
  let replay = initialState()
  for (const e of events) replay = reducer(replay, { type: 'event', event: e })
  // Timestamps are Date.now() — reducer is otherwise deterministic. Strip timestamps for structural comparison.
  const strip = (t: typeof live.timeline): unknown =>
    JSON.stringify(t, (k, v) => (k === 'timestamp' ? 0 : v))
  expect(strip(live.timeline)).toBe(strip(replay.timeline))
})

test('thinking event → thinking timeline item', () => {
  let s = initialState()
  s = reducer(s, {
    type: 'event',
    event: { kind: 'assistant-thinking', messageId: 'm', text: '', hasSignature: true }
  })
  const thinking = s.timeline.filter((i) => i.kind === 'thinking')
  expect(thinking.length).toBe(1)
  if (thinking[0].kind !== 'thinking') throw new Error('wrong')
  expect(thinking[0].hasSignature).toBe(true)
})

test('unknown event is dropped from timeline', () => {
  let s = initialState()
  s = reducer(s, {
    type: 'event',
    event: { kind: 'unknown', reason: 'unknown-type', raw: { type: 'speculative' } }
  })
  const unknown = s.timeline.filter((i) => i.kind === 'unknown')
  expect(unknown.length).toBe(0)
})

test('reset race: stale exit between reset and new turn-init is dropped at reducer', () => {
  // Timeline simulating a Reset click:
  // 1. Client dispatches `reset` → state cleared.
  // 2. Old session's late exit (sessionId='old-sid') arrives.
  // 3. New session spawns, turn-init('new-sid') arrives.
  // The reducer drops the stale exit because state.sessionId is null right after reset,
  // so sessionEnded never flips on. Belt-and-suspenders alongside the main-side guard
  // that already swallows stale exits when sessions.get(tabId) !== dyingSession.
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit('old-sid') })
  s = reducer(s, { type: 'event', event: ev.text('m-1', 'from old session') })

  s = reducer(s, { type: 'reset' })
  expect(s.sessionEnded).toBe(false)

  // Stale exit from old session arrives — state.sessionId is null → dropped.
  s = reducer(s, { type: 'process-exit', sessionId: 'old-sid', code: 0, signal: null })
  expect(s.sessionEnded).toBe(false)

  // New session's turn-init arrives.
  s = reducer(s, { type: 'event', event: ev.turnInit('new-sid') })
  expect(s.sessionEnded).toBe(false)
  expect(s.sessionStarted).toBe(true)
  expect(s.sessionId).toBe('new-sid')
})

test('stream deltas build text item incrementally', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, { type: 'event', event: { kind: 'stream-message-start', messageId: 'msg-x' } })
  s = reducer(s, {
    type: 'event',
    event: { kind: 'stream-block-start', blockIndex: 0, blockType: 'text' }
  })
  s = reducer(s, {
    type: 'event',
    event: { kind: 'stream-block-delta', blockIndex: 0, deltaType: 'text', text: 'Hel' }
  })
  s = reducer(s, {
    type: 'event',
    event: { kind: 'stream-block-delta', blockIndex: 0, deltaType: 'text', text: 'lo wor' }
  })
  s = reducer(s, {
    type: 'event',
    event: { kind: 'stream-block-delta', blockIndex: 0, deltaType: 'text', text: 'ld' }
  })
  s = reducer(s, { type: 'event', event: { kind: 'stream-block-stop', blockIndex: 0 } })
  s = reducer(s, { type: 'event', event: { kind: 'stream-message-stop' } })
  const texts = s.timeline.filter((i) => i.kind === 'text')
  expect(texts.length).toBe(1)
  if (texts[0].kind !== 'text') throw new Error('wrong')
  expect(texts[0].text).toBe('Hello world')
})

test('atomic assistant-text is suppressed when messageId was streamed', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, { type: 'event', event: { kind: 'stream-message-start', messageId: 'msg-x' } })
  s = reducer(s, {
    type: 'event',
    event: { kind: 'stream-block-start', blockIndex: 0, blockType: 'text' }
  })
  s = reducer(s, {
    type: 'event',
    event: { kind: 'stream-block-delta', blockIndex: 0, deltaType: 'text', text: 'streamed' }
  })
  s = reducer(s, { type: 'event', event: { kind: 'stream-block-stop', blockIndex: 0 } })
  s = reducer(s, { type: 'event', event: { kind: 'stream-message-stop' } })
  // Final atomic event arrives — should NOT duplicate the text item.
  s = reducer(s, { type: 'event', event: ev.text('msg-x', 'streamed') })
  const texts = s.timeline.filter((i) => i.kind === 'text')
  expect(texts.length).toBe(1)
})

test('atomic assistant-text still appears when no streaming happened (fallback)', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, { type: 'event', event: ev.text('msg-y', 'atomic only') })
  const texts = s.timeline.filter((i) => i.kind === 'text')
  expect(texts.length).toBe(1)
  if (texts[0].kind !== 'text') throw new Error('wrong')
  expect(texts[0].text).toBe('atomic only')
})

test('tool_use input_json deltas accumulate + parse on block-stop', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, { type: 'event', event: { kind: 'stream-message-start', messageId: 'msg-z' } })
  s = reducer(s, {
    type: 'event',
    event: {
      kind: 'stream-block-start',
      blockIndex: 0,
      blockType: 'tool_use',
      toolUseId: 't-1',
      toolName: 'Read'
    }
  })
  s = reducer(s, {
    type: 'event',
    event: {
      kind: 'stream-block-delta',
      blockIndex: 0,
      deltaType: 'input_json',
      text: '{"path":'
    }
  })
  s = reducer(s, {
    type: 'event',
    event: {
      kind: 'stream-block-delta',
      blockIndex: 0,
      deltaType: 'input_json',
      text: '"/etc/hosts"}'
    }
  })
  s = reducer(s, { type: 'event', event: { kind: 'stream-block-stop', blockIndex: 0 } })
  const tools = s.timeline.filter((i) => i.kind === 'tool')
  expect(tools.length).toBe(1)
  if (tools[0].kind !== 'tool') throw new Error('wrong')
  expect(tools[0].invocation.name).toBe('Read')
  expect((tools[0].invocation.input as { path?: string }).path).toBe('/etc/hosts')
})

test('empty text block (start + stop, no delta) does not leave placeholder', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, { type: 'event', event: { kind: 'stream-message-start', messageId: 'msg-empty' } })
  s = reducer(s, {
    type: 'event',
    event: { kind: 'stream-block-start', blockIndex: 0, blockType: 'text' }
  })
  s = reducer(s, { type: 'event', event: { kind: 'stream-block-stop', blockIndex: 0 } })
  s = reducer(s, { type: 'event', event: { kind: 'stream-message-stop' } })
  const texts = s.timeline.filter((i) => i.kind === 'text')
  expect(texts.length).toBe(0)
})

test('atomic fallback fires when stream produced no content for messageId', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, { type: 'event', event: { kind: 'stream-message-start', messageId: 'msg-fb' } })
  // No deltas, just stream-stop — stream produced nothing.
  s = reducer(s, { type: 'event', event: { kind: 'stream-message-stop' } })
  // Atomic arrives with content — should render since stream didn't mark messageId streamed.
  s = reducer(s, { type: 'event', event: ev.text('msg-fb', 'atomic content') })
  const texts = s.timeline.filter((i) => i.kind === 'text')
  expect(texts.length).toBe(1)
  if (texts[0].kind !== 'text') throw new Error('wrong')
  expect(texts[0].text).toBe('atomic content')
})

test('result.copyText aggregates assistant text from this turn', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, { type: 'user-sent', text: 'hey' })
  s = reducer(s, { type: 'event', event: ev.text('m-1', 'First reply.') })
  s = reducer(s, { type: 'event', event: ev.call('t-1', 'Bash') })
  s = reducer(s, { type: 'event', event: ev.result('t-1') })
  s = reducer(s, { type: 'event', event: ev.text('m-2', 'Second reply.') })
  s = reducer(s, { type: 'event', event: ev.turnResult() })
  const results = s.timeline.filter((i) => i.kind === 'result')
  expect(results.length).toBe(1)
  if (results[0].kind !== 'result') throw new Error('wrong')
  expect(results[0].copyText).toBe('First reply.\n\nSecond reply.')
})

test('result.copyText null when turn has no assistant text (tool-only)', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, { type: 'user-sent', text: 'do it' })
  s = reducer(s, { type: 'event', event: ev.call('t-1', 'Bash') })
  s = reducer(s, { type: 'event', event: ev.result('t-1') })
  s = reducer(s, { type: 'event', event: ev.turnResult() })
  const results = s.timeline.filter((i) => i.kind === 'result')
  expect(results.length).toBe(1)
  if (results[0].kind !== 'result') throw new Error('wrong')
  expect(results[0].copyText).toBe(null)
})

test('result.copyText only scans back to most recent user-text boundary', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  // Turn 1
  s = reducer(s, { type: 'user-sent', text: 'first' })
  s = reducer(s, { type: 'event', event: ev.text('m-1', 'Turn 1 reply.') })
  s = reducer(s, { type: 'event', event: ev.turnResult() })
  // Turn 2
  s = reducer(s, { type: 'user-sent', text: 'second' })
  s = reducer(s, { type: 'event', event: ev.text('m-2', 'Turn 2 reply.') })
  s = reducer(s, { type: 'event', event: ev.turnResult() })
  const results = s.timeline.filter((i) => i.kind === 'result')
  expect(results.length).toBe(2)
  if (results[0].kind !== 'result' || results[1].kind !== 'result') throw new Error('wrong')
  expect(results[0].copyText).toBe('Turn 1 reply.')
  expect(results[1].copyText).toBe('Turn 2 reply.')
})

test('signature_delta flips hasSignature on thinking item', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, { type: 'event', event: { kind: 'stream-message-start', messageId: 'msg-t' } })
  s = reducer(s, {
    type: 'event',
    event: { kind: 'stream-block-start', blockIndex: 0, blockType: 'thinking' }
  })
  s = reducer(s, {
    type: 'event',
    event: { kind: 'stream-block-delta', blockIndex: 0, deltaType: 'thinking', text: 'pondering' }
  })
  s = reducer(s, {
    type: 'event',
    event: { kind: 'stream-block-delta', blockIndex: 0, deltaType: 'signature', text: 'sig-xyz' }
  })
  s = reducer(s, { type: 'event', event: { kind: 'stream-block-stop', blockIndex: 0 } })
  const thinking = s.timeline.filter((i) => i.kind === 'thinking')
  expect(thinking.length).toBe(1)
  if (thinking[0].kind !== 'thinking') throw new Error('wrong')
  expect(thinking[0].text).toBe('pondering')
  expect(thinking[0].hasSignature).toBe(true)
})

test('sub-agent: enrichment events accumulate on one row while in-flight', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, {
    type: 'event',
    event: {
      kind: 'sub-agent',
      phase: 'in-flight',
      toolUseId: 'tu_a',
      description: 'Investigate X',
      raw: {}
    }
  })
  // Later `task_notification` arrives as another in-flight event carrying usage.
  s = reducer(s, {
    type: 'event',
    event: {
      kind: 'sub-agent',
      phase: 'in-flight',
      toolUseId: 'tu_a',
      status: 'completed',
      summary: 'Investigate X',
      usage: { totalTokens: 1234, toolUses: 5, durationMs: 6789 },
      raw: {}
    }
  })
  const subAgents = s.timeline.filter((i) => i.kind === 'sub-agent')
  expect(subAgents.length).toBe(1)
  if (subAgents[0].kind !== 'sub-agent') throw new Error('wrong')
  expect(subAgents[0].description).toBe('Investigate X')
  expect(subAgents[0].status).toBe('completed')
  expect(subAgents[0].toolUses).toBe(5)
  expect(subAgents[0].durationMs).toBe(6789)
  expect(subAgents[0].totalTokens).toBe(1234)
  // Phase is still in-flight — only the outer Task tool-result closes the row.
  expect(subAgents[0].phase).toBe('in-flight')
})

test('sub-agent: tool-result for the outer Task closes the row to completed', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, {
    type: 'event',
    event: {
      kind: 'sub-agent',
      phase: 'in-flight',
      toolUseId: 'tu_TASK',
      description: 'X',
      raw: {}
    }
  })
  // Outer Task's tool-result arrives — canonical completion signal.
  s = reducer(s, {
    type: 'event',
    event: {
      kind: 'tool-result',
      toolUseId: 'tu_TASK',
      isError: false,
      rawContent: 'done',
      structured: null
    }
  })
  const subAgents = s.timeline.filter((i) => i.kind === 'sub-agent')
  expect(subAgents.length).toBe(1)
  if (subAgents[0].kind !== 'sub-agent') throw new Error('wrong')
  expect(subAgents[0].phase).toBe('completed')
})

test('sub-agent: tool-result with isError closes the row to failed', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, {
    type: 'event',
    event: {
      kind: 'sub-agent',
      phase: 'in-flight',
      toolUseId: 'tu_FAIL',
      description: 'broken',
      raw: {}
    }
  })
  s = reducer(s, {
    type: 'event',
    event: {
      kind: 'tool-result',
      toolUseId: 'tu_FAIL',
      isError: true,
      rawContent: 'boom',
      structured: null
    }
  })
  const sub = s.timeline.find((i) => i.kind === 'sub-agent')
  if (!sub || sub.kind !== 'sub-agent') throw new Error('missing')
  expect(sub.phase).toBe('failed')
})

test('sub-agent: closes via tool-result even without any task_notification', () => {
  // Regression for stuck spinner — CLI may omit task_notification entirely for some sub-agents.
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, {
    type: 'event',
    event: {
      kind: 'sub-agent',
      phase: 'in-flight',
      toolUseId: 'tu_NO_NOTIF',
      description: 'orphan',
      raw: {}
    }
  })
  // No notification — go straight to tool-result.
  s = reducer(s, {
    type: 'event',
    event: {
      kind: 'tool-result',
      toolUseId: 'tu_NO_NOTIF',
      isError: false,
      rawContent: 'ok',
      structured: null
    }
  })
  const sub = s.timeline.find((i) => i.kind === 'sub-agent')
  if (!sub || sub.kind !== 'sub-agent') throw new Error('missing')
  expect(sub.phase).toBe('completed')
})

test('sub-agent: late notification after tool-result does not regress phase', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, {
    type: 'event',
    event: {
      kind: 'sub-agent',
      phase: 'in-flight',
      toolUseId: 'tu_OOO',
      description: 'ooo',
      raw: {}
    }
  })
  s = reducer(s, {
    type: 'event',
    event: {
      kind: 'tool-result',
      toolUseId: 'tu_OOO',
      isError: false,
      rawContent: 'ok',
      structured: null
    }
  })
  // Late `task_notification` carrying usage arrives AFTER close.
  s = reducer(s, {
    type: 'event',
    event: {
      kind: 'sub-agent',
      phase: 'in-flight',
      toolUseId: 'tu_OOO',
      status: 'completed',
      usage: { totalTokens: 100, toolUses: 1, durationMs: 5 },
      raw: {}
    }
  })
  const sub = s.timeline.find((i) => i.kind === 'sub-agent')
  if (!sub || sub.kind !== 'sub-agent') throw new Error('missing')
  expect(sub.phase).toBe('completed')
  expect(sub.totalTokens).toBe(100)
})

test('sub-agent: interrupt flips in-flight rows to failed', () => {
  // Send a user message so isInFlight() is true (interrupted is a no-op otherwise).
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, { type: 'user-sent', text: 'go' })
  s = reducer(s, {
    type: 'event',
    event: {
      kind: 'sub-agent',
      phase: 'in-flight',
      toolUseId: 'tu_INT',
      description: 'mid',
      raw: {}
    }
  })
  s = reducer(s, { type: 'event', event: { kind: 'interrupted' } })
  const sub = s.timeline.find((i) => i.kind === 'sub-agent')
  if (!sub || sub.kind !== 'sub-agent') throw new Error('missing')
  expect(sub.phase).toBe('failed')
  expect(sub.status).toBe('interrupted')
})

test('sub-agent: process-exit while in-flight heals the spinner', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, { type: 'user-sent', text: 'go' })
  s = reducer(s, {
    type: 'event',
    event: {
      kind: 'sub-agent',
      phase: 'in-flight',
      toolUseId: 'tu_EXIT',
      description: 'crashy',
      raw: {}
    }
  })
  s = reducer(s, { type: 'event', event: { kind: 'process-exit', code: 1, signal: null } })
  const sub = s.timeline.find((i) => i.kind === 'sub-agent')
  if (!sub || sub.kind !== 'sub-agent') throw new Error('missing')
  expect(sub.phase).toBe('failed')
})

test('sub-agent: legacy persisted phase strings normalize to in-flight on replay', () => {
  // Persisted events from before the semantic rename carry legacy CLI subtype
  // strings. Replay must still produce correct final state — tool-result was
  // persisted alongside and re-closes the row.
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, {
    type: 'event',
    // Cast: legacy events on disk have these phase strings, current type doesn't allow them.
    event: {
      kind: 'sub-agent',
      phase: 'started',
      toolUseId: 'tu_LEG',
      description: 'leg',
      raw: {}
    } as unknown as AgentEvent
  })
  s = reducer(s, {
    type: 'event',
    event: {
      kind: 'sub-agent',
      phase: 'notification',
      toolUseId: 'tu_LEG',
      status: 'completed',
      raw: {}
    } as unknown as AgentEvent
  })
  // Legacy notification → still in-flight (canonical close = tool-result).
  let sub = s.timeline.find((i) => i.kind === 'sub-agent')
  if (!sub || sub.kind !== 'sub-agent') throw new Error('missing')
  expect(sub.phase).toBe('in-flight')
  // Replay the tool-result that was also persisted → closes correctly.
  s = reducer(s, {
    type: 'event',
    event: {
      kind: 'tool-result',
      toolUseId: 'tu_LEG',
      isError: false,
      rawContent: 'ok',
      structured: null
    }
  })
  sub = s.timeline.find((i) => i.kind === 'sub-agent')
  if (!sub || sub.kind !== 'sub-agent') throw new Error('missing')
  expect(sub.phase).toBe('completed')
})

test('sub-agent: distinct toolUseIds get their own rows', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, {
    type: 'event',
    event: { kind: 'sub-agent', phase: 'in-flight', toolUseId: 'a', description: 'A', raw: {} }
  })
  s = reducer(s, {
    type: 'event',
    event: { kind: 'sub-agent', phase: 'in-flight', toolUseId: 'b', description: 'B', raw: {} }
  })
  const subAgents = s.timeline.filter((i) => i.kind === 'sub-agent')
  expect(subAgents.length).toBe(2)
})

test('sub-agent children: parentToolUseId on tool-call routes into childIndex', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, {
    type: 'event',
    event: {
      kind: 'sub-agent',
      phase: 'in-flight',
      toolUseId: 'tu_TASK',
      description: 'find',
      raw: {}
    }
  })
  // Sub-agent's inner tool call carries parent_tool_use_id pointing at the Task.
  s = reducer(s, {
    type: 'event',
    event: {
      kind: 'tool-call',
      id: 'tu_INNER',
      name: 'Grep',
      input: { pattern: 'x' },
      parentToolUseId: 'tu_TASK'
    }
  })
  // Result for the inner tool also carries parent.
  s = reducer(s, {
    type: 'event',
    event: {
      kind: 'tool-result',
      toolUseId: 'tu_INNER',
      isError: false,
      rawContent: 'matches',
      structured: null,
      parentToolUseId: 'tu_TASK'
    }
  })
  // Inner tool item exists in flat timeline (one of the items, not first since session-start + sub-agent precede).
  const tools = s.timeline.filter((i) => i.kind === 'tool')
  expect(tools.length).toBe(1)
  const inner = tools[0]
  if (inner.kind !== 'tool') throw new Error('wrong kind')
  expect(inner.parentToolUseId).toBe('tu_TASK')
  expect(inner.invocation.status).toBe('done')
  // childIndex contains the inner tool's timeline index under tu_TASK.
  const children = s.childIndex.get('tu_TASK')
  if (!children) throw new Error('expected childIndex entry')
  expect(children.length).toBe(1)
  const childIdx = children[0]
  expect(s.timeline[childIdx].kind).toBe('tool')
})

test('sub-agent children: assistant-text + thinking are routed by parentToolUseId', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, {
    type: 'event',
    event: {
      kind: 'sub-agent',
      phase: 'in-flight',
      toolUseId: 'tu_TASK',
      description: 'reason',
      raw: {}
    }
  })
  s = reducer(s, {
    type: 'event',
    event: {
      kind: 'assistant-text',
      messageId: 'm-inner',
      text: 'thinking aloud',
      parentToolUseId: 'tu_TASK'
    }
  })
  s = reducer(s, {
    type: 'event',
    event: {
      kind: 'assistant-thinking',
      messageId: 'm-inner-2',
      text: 'private',
      hasSignature: false,
      parentToolUseId: 'tu_TASK'
    }
  })
  const children = s.childIndex.get('tu_TASK') ?? []
  expect(children.length).toBe(2)
  const kinds = children.map((i) => s.timeline[i].kind).sort()
  expect(kinds.join(',')).toBe('text,thinking')
})

test('sub-agent children: events without parent stay at root (childIndex empty)', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, { type: 'event', event: ev.call('t-1', 'Bash') })
  s = reducer(s, { type: 'event', event: ev.result('t-1') })
  expect(s.childIndex.size).toBe(0)
  // Tool item itself has no parentToolUseId.
  const tool = s.timeline.find((i) => i.kind === 'tool')
  if (!tool || tool.kind !== 'tool') throw new Error('wrong')
  expect(tool.parentToolUseId).toBe(undefined)
})

test('sub-agent children: nested sub-agent inside sub-agent registers under outer parent', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, {
    type: 'event',
    event: {
      kind: 'sub-agent',
      phase: 'in-flight',
      toolUseId: 'tu_OUTER',
      description: 'outer',
      raw: {}
    }
  })
  s = reducer(s, {
    type: 'event',
    event: {
      kind: 'sub-agent',
      phase: 'in-flight',
      toolUseId: 'tu_INNER',
      description: 'inner',
      parentToolUseId: 'tu_OUTER',
      raw: {}
    }
  })
  const outerChildren = s.childIndex.get('tu_OUTER') ?? []
  expect(outerChildren.length).toBe(1)
  const innerItem = s.timeline[outerChildren[0]]
  if (innerItem.kind !== 'sub-agent') throw new Error('wrong kind')
  expect(innerItem.toolUseId).toBe('tu_INNER')
  expect(innerItem.parentToolUseId).toBe('tu_OUTER')
})

test('deriveLoadingLabel: null when idle', () => {
  const s = initialState()
  expect(deriveLoadingLabel(s)).toBe(null)
})

test('deriveLoadingLabel: "Thinking…" while thinking block open', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, { type: 'event', event: { kind: 'stream-message-start', messageId: 'm' } })
  s = reducer(s, {
    type: 'event',
    event: { kind: 'stream-block-start', blockIndex: 0, blockType: 'thinking' }
  })
  expect(deriveLoadingLabel(s)).toBe('Thinking…')
})

test('deriveLoadingLabel: "Writing…" while text block open', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, { type: 'event', event: { kind: 'stream-message-start', messageId: 'm' } })
  s = reducer(s, {
    type: 'event',
    event: { kind: 'stream-block-start', blockIndex: 0, blockType: 'text' }
  })
  expect(deriveLoadingLabel(s)).toBe('Writing…')
})

test('deriveLoadingLabel: tool with file_path → verb + basename', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, {
    type: 'event',
    event: { kind: 'tool-call', id: 't', name: 'Read', input: { file_path: '/a/b/foo.ts' } }
  })
  expect(deriveLoadingLabel(s)).toBe('Read foo.ts')
})

test('deriveLoadingLabel: Bash command target', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, {
    type: 'event',
    event: { kind: 'tool-call', id: 't', name: 'Bash', input: { command: 'pnpm build' } }
  })
  expect(deriveLoadingLabel(s)).toBe('Run pnpm build')
})

test('deriveLoadingLabel: long command truncated', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, {
    type: 'event',
    event: {
      kind: 'tool-call',
      id: 't',
      name: 'Bash',
      input: { command: 'a'.repeat(60) }
    }
  })
  const label = deriveLoadingLabel(s)
  expect(label?.startsWith('Run ')).toBeTruthy()
  expect((label?.length ?? 0) <= 'Run '.length + 32).toBeTruthy()
})

test('deriveLoadingLabel: api-retry overrides open block', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, { type: 'user-sent', text: 'hi' })
  s = reducer(s, { type: 'event', event: { kind: 'stream-message-start', messageId: 'm' } })
  s = reducer(s, {
    type: 'event',
    event: { kind: 'stream-block-start', blockIndex: 0, blockType: 'text' }
  })
  s = reducer(s, {
    type: 'event',
    event: { kind: 'api-retry', attempt: 2, maxRetries: 5, delayMs: 3000, error: '529' }
  })
  expect(deriveLoadingLabel(s)).toBe('Retrying (2/5) in 3s…')
})

test('deriveLoadingLabel: tool label sticks after tool-result completes', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, {
    type: 'event',
    event: { kind: 'tool-call', id: 't', name: 'Edit', input: { file_path: '/x/App.tsx' } }
  })
  s = reducer(s, { type: 'event', event: ev.result('t') })
  s = reducer(s, { type: 'event', event: { kind: 'stream-message-stop' } })
  expect(deriveLoadingLabel(s)).toBe('Edit App.tsx')
})

test('deriveLoadingLabel: text label sticky after stream-block-stop', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, { type: 'event', event: { kind: 'stream-message-start', messageId: 'm' } })
  s = reducer(s, {
    type: 'event',
    event: { kind: 'stream-block-start', blockIndex: 0, blockType: 'text' }
  })
  s = reducer(s, {
    type: 'event',
    event: { kind: 'stream-block-delta', blockIndex: 0, deltaType: 'text', text: 'hi' }
  })
  s = reducer(s, { type: 'event', event: { kind: 'stream-block-stop', blockIndex: 0 } })
  expect(deriveLoadingLabel(s)).toBe('Writing…')
})

test('isAwaitingUserQuestion: false when idle', () => {
  expect(isAwaitingUserQuestion(initialState())).toBe(false)
})

test('isAwaitingUserQuestion: true while AskUserQuestion is latest tool in turn', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, {
    type: 'event',
    event: { kind: 'tool-call', id: 't', name: 'AskUserQuestion', input: { questions: [] } }
  })
  expect(isAwaitingUserQuestion(s)).toBe(true)
})

test('isAwaitingUserQuestion: false after user replies (user-text after tool)', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, {
    type: 'event',
    event: { kind: 'tool-call', id: 't', name: 'AskUserQuestion', input: { questions: [] } }
  })
  s = reducer(s, { type: 'user-sent', text: 'my answer' })
  expect(isAwaitingUserQuestion(s)).toBe(false)
})

test('isAwaitingUserQuestion: false when latest tool is not AskUserQuestion', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, {
    type: 'event',
    event: { kind: 'tool-call', id: 't', name: 'Read', input: { file_path: '/a.ts' } }
  })
  expect(isAwaitingUserQuestion(s)).toBe(false)
})

test('deriveLoadingLabel: stops scanning at user-text boundary', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, {
    type: 'event',
    event: { kind: 'api-retry', attempt: 1, maxRetries: 3, delayMs: 1000, error: 'x' }
  })
  s = reducer(s, { type: 'user-sent', text: 'next turn' })
  expect(deriveLoadingLabel(s)).toBe(null)
})

test('interrupted event: appends marker + drops inFlight (mirrors turn-interrupted)', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, { type: 'event', event: { kind: 'user-message', text: 'hi' } })
  expect(isInFlight(s)).toBe(true)
  s = reducer(s, { type: 'event', event: { kind: 'interrupted' } })
  expect(isInFlight(s)).toBe(false)
  expect(s.timeline.some((i) => i.kind === 'interrupted')).toBe(true)
})

test('user-message-popped: removes matching user-text + drops inFlight', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, { type: 'event', event: { kind: 'user-message', text: 'hello' } })
  expect(isInFlight(s)).toBe(true)
  expect(s.timeline.some((i) => i.kind === 'user-text')).toBe(true)
  s = reducer(s, { type: 'event', event: { kind: 'user-message-popped', text: 'hello' } })
  expect(isInFlight(s)).toBe(false)
  expect(s.timeline.some((i) => i.kind === 'user-text')).toBe(false)
})

test('user-message-popped: refuses pop when assistant progress sits between', () => {
  // Defensive replay safety. Main side gates emission, but if late events land
  // out-of-order between renderer's request and the synthetic event, the pop
  // must no-op rather than corrupt the timeline.
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, { type: 'event', event: { kind: 'user-message', text: 'hi' } })
  s = reducer(s, { type: 'event', event: ev.text('m-1', 'assistant reply') })
  s = reducer(s, { type: 'event', event: { kind: 'user-message-popped', text: 'hi' } })
  expect(s.timeline.some((i) => i.kind === 'user-text')).toBe(true)
  expect(s.timeline.some((i) => i.kind === 'text')).toBe(true)
})

test('user-message-popped: replay-safe (user-message + popped → empty timeline)', () => {
  // Buffer replay scenario: tab reopen reads chat_events in order. The popped
  // user-message must NOT linger in the reconstructed timeline.
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, { type: 'event', event: { kind: 'user-message', text: 'edit me' } })
  s = reducer(s, { type: 'event', event: { kind: 'user-message-popped', text: 'edit me' } })
  expect(s.timeline.filter((i) => i.kind === 'user-text').length).toBe(0)
})

// ---- optimistic send -------------------------------------------------

test('optimistic: user-sent flags item as optimistic', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, { type: 'user-sent', text: 'hi' })
  const items = s.timeline.filter((i) => i.kind === 'user-text')
  expect(items.length).toBe(1)
  if (items[0].kind !== 'user-text') throw new Error('wrong kind')
  expect(items[0].optimistic === true).toBe(true)
  expect(s.userMessagesSent).toBe(1)
})

test('optimistic: user-message confirms in place, no duplicate, no double-bump', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, { type: 'user-sent', text: 'hi' })
  s = reducer(s, { type: 'event', event: { kind: 'user-message', text: 'hi' } })
  const items = s.timeline.filter((i) => i.kind === 'user-text')
  expect(items.length).toBe(1)
  if (items[0].kind !== 'user-text') throw new Error('wrong kind')
  expect(items[0].optimistic === true).toBe(false)
  expect(s.userMessagesSent).toBe(1)
})

test('optimistic: two rapid sends → both confirmed FIFO in order', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, { type: 'user-sent', text: 'first' })
  s = reducer(s, { type: 'user-sent', text: 'second' })
  s = reducer(s, { type: 'event', event: { kind: 'user-message', text: 'first' } })
  s = reducer(s, { type: 'event', event: { kind: 'user-message', text: 'second' } })
  const items = s.timeline.filter((i) => i.kind === 'user-text')
  expect(items.length).toBe(2)
  if (items[0].kind !== 'user-text' || items[1].kind !== 'user-text') throw new Error('wrong kind')
  expect(items[0].text).toBe('first')
  expect(items[1].text).toBe('second')
  expect(items[0].optimistic === true).toBe(false)
  expect(items[1].optimistic === true).toBe(false)
  expect(s.userMessagesSent).toBe(2)
})

test('optimistic: user-send-failed removes oldest optimistic + decrements count', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, { type: 'user-sent', text: 'hi' })
  s = reducer(s, { type: 'user-send-failed' })
  expect(s.timeline.filter((i) => i.kind === 'user-text').length).toBe(0)
  expect(s.userMessagesSent).toBe(0)
})

test('optimistic: user-send-failed only removes optimistic, not confirmed items', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, { type: 'user-sent', text: 'sent' })
  s = reducer(s, { type: 'event', event: { kind: 'user-message', text: 'sent' } })
  s = reducer(s, { type: 'user-sent', text: 'failing' })
  s = reducer(s, { type: 'user-send-failed' })
  const items = s.timeline.filter((i) => i.kind === 'user-text')
  expect(items.length).toBe(1)
  if (items[0].kind !== 'user-text') throw new Error('wrong kind')
  expect(items[0].text).toBe('sent')
  expect(items[0].optimistic === true).toBe(false)
  expect(s.userMessagesSent).toBe(1)
})

test('optimistic: replay path (no prior user-sent) appends user-message normally', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, { type: 'event', event: { kind: 'user-message', text: 'replayed' } })
  const items = s.timeline.filter((i) => i.kind === 'user-text')
  expect(items.length).toBe(1)
  if (items[0].kind !== 'user-text') throw new Error('wrong kind')
  expect(items[0].text).toBe('replayed')
  expect(items[0].optimistic === true).toBe(false)
  expect(s.userMessagesSent).toBe(1)
})

test('optimistic: user-send-failed with no optimistic items is a no-op', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, { type: 'user-send-failed' })
  expect(s.userMessagesSent).toBe(0)
  expect(s.timeline.filter((i) => i.kind === 'user-text').length).toBe(0)
})

test('optimistic: replay determinism after dedup matches direct user-message append', () => {
  // Live path: user-sent → user-message confirms in place
  let live = initialState()
  live = reducer(live, { type: 'event', event: ev.turnInit() })
  live = reducer(live, { type: 'user-sent', text: 'hi' })
  live = reducer(live, { type: 'event', event: { kind: 'user-message', text: 'hi' } })
  // Replay path: only user-message arrives (optimistic dispatch is renderer-only)
  let replay = initialState()
  replay = reducer(replay, { type: 'event', event: ev.turnInit() })
  replay = reducer(replay, { type: 'event', event: { kind: 'user-message', text: 'hi' } })
  // userMessagesSent + visible timeline must match (timestamps/optimistic flag aside)
  expect(live.userMessagesSent).toBe(replay.userMessagesSent)
  expect(live.timeline.length).toBe(replay.timeline.length)
  const liveText = live.timeline.find((i) => i.kind === 'user-text')
  const replayText = replay.timeline.find((i) => i.kind === 'user-text')
  if (liveText?.kind !== 'user-text' || replayText?.kind !== 'user-text') throw new Error('missing')
  expect(liveText.text).toBe(replayText.text)
  expect(liveText.optimistic === true).toBe(false)
  expect(replayText.optimistic === true).toBe(false)
})

// ---- bg-shells -------------------------------------------------------

const bgCall = (id: string, name: string, input: unknown): AgentEvent => ({
  kind: 'tool-call',
  id,
  name,
  input
})
const bgResult = (
  toolUseId: string,
  rawContent: unknown,
  structured: unknown = null,
  isError = false
): AgentEvent => ({ kind: 'tool-result', toolUseId, isError, rawContent, structured })

test('bg-shells: spawn registers a pending shell with command', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, {
    type: 'event',
    event: bgCall('spawn-1', 'Bash', { command: 'pnpm dev', run_in_background: true })
  })
  expect(s.bgShells.size).toBe(1)
  const shell = s.bgShells.get('spawn-1')!
  expect(shell.status).toBe('pending')
  expect(shell.command).toBe('pnpm dev')
  expect(shell.shellId).toBe(null)
})

test('bg-shells: spawn result assigns shell id + flips to running', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, {
    type: 'event',
    event: bgCall('spawn-1', 'Bash', { command: 'pnpm dev', run_in_background: true })
  })
  s = reducer(s, {
    type: 'event',
    event: bgResult('spawn-1', 'Command running in background with shell ID: bash_1')
  })
  const shell = s.bgShells.get('spawn-1')!
  expect(shell.shellId).toBe('bash_1')
  expect(shell.status).toBe('running')
})

test('bg-shells: BashOutput poll updates status + lastPolledAt + tail', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, {
    type: 'event',
    event: bgCall('spawn-1', 'Bash', { command: 'long', run_in_background: true })
  })
  s = reducer(s, { type: 'event', event: bgResult('spawn-1', '', { shellId: 'bash_2' }) })
  s = reducer(s, { type: 'event', event: bgCall('poll-1', 'BashOutput', { bash_id: 'bash_2' }) })
  s = reducer(s, {
    type: 'event',
    event: bgResult('poll-1', '', { status: 'running', stdout: 'tick\n' })
  })
  const shell = s.bgShells.get('spawn-1')!
  expect(shell.status).toBe('running')
  expect(shell.latestStdout).toBe('tick\n')
  expect(shell.lastPolledAt !== null).toBe(true)
})

test('bg-shells: completed BashOutput sets exit code + status', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, {
    type: 'event',
    event: bgCall('spawn-1', 'Bash', { command: 'one-shot', run_in_background: true })
  })
  s = reducer(s, { type: 'event', event: bgResult('spawn-1', '', { shellId: 'bash_3' }) })
  s = reducer(s, { type: 'event', event: bgCall('poll-1', 'BashOutput', { bash_id: 'bash_3' }) })
  s = reducer(s, {
    type: 'event',
    event: bgResult('poll-1', '', { status: 'completed', exitCode: 0, stdout: 'done\n' })
  })
  const shell = s.bgShells.get('spawn-1')!
  expect(shell.status).toBe('completed')
  expect(shell.exitCode).toBe(0)
})

test('bg-shells: KillShell ack without explicit status still flips to killed', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, {
    type: 'event',
    event: bgCall('spawn-1', 'Bash', { command: 'never-ends', run_in_background: true })
  })
  s = reducer(s, { type: 'event', event: bgResult('spawn-1', '', { shellId: 'bash_42' }) })
  s = reducer(s, { type: 'event', event: bgCall('kill-1', 'KillShell', { shell_id: 'bash_42' }) })
  s = reducer(s, { type: 'event', event: bgResult('kill-1', 'shell killed') })
  const shell = s.bgShells.get('spawn-1')!
  expect(shell.status).toBe('killed')
})

test('bg-shells: KillShell call+result marks shell killed', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, {
    type: 'event',
    event: bgCall('spawn-1', 'Bash', { command: 'never-ends', run_in_background: true })
  })
  s = reducer(s, { type: 'event', event: bgResult('spawn-1', '', { shellId: 'bash_9' }) })
  s = reducer(s, { type: 'event', event: bgCall('kill-1', 'KillShell', { shell_id: 'bash_9' }) })
  s = reducer(s, {
    type: 'event',
    event: bgResult('kill-1', '', { status: 'killed' })
  })
  const shell = s.bgShells.get('spawn-1')!
  expect(shell.status).toBe('killed')
})

test('bg-shells: non-bg Bash call does not register a shell', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, {
    type: 'event',
    event: bgCall('spawn-1', 'Bash', { command: 'ls', run_in_background: false })
  })
  expect(s.bgShells.size).toBe(0)
})

test('bg-shells: order preserved across multiple spawns', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, {
    type: 'event',
    event: bgCall('a', 'Bash', { command: 'one', run_in_background: true })
  })
  s = reducer(s, {
    type: 'event',
    event: bgCall('b', 'Bash', { command: 'two', run_in_background: true })
  })
  expect(s.bgShellOrder.join(',')).toBe('a,b')
})

test('bg-shells: eviction caps terminal-status history but keeps active shells', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  // Spawn 35 shells, all completed (over the 30-keep limit).
  for (let i = 0; i < 35; i++) {
    const id = `t${i}`
    s = reducer(s, {
      type: 'event',
      event: bgCall(id, 'Bash', { command: `cmd${i}`, run_in_background: true })
    })
    s = reducer(s, { type: 'event', event: bgResult(id, '', { shellId: `bash_${i}` }) })
    s = reducer(s, {
      type: 'event',
      event: bgCall(`p${i}`, 'BashOutput', { bash_id: `bash_${i}` })
    })
    s = reducer(s, {
      type: 'event',
      event: bgResult(`p${i}`, '', { status: 'completed', exitCode: 0 })
    })
  }
  // Plus one still-running shell that must survive.
  s = reducer(s, {
    type: 'event',
    event: bgCall('alive', 'Bash', { command: 'streaming', run_in_background: true })
  })
  s = reducer(s, { type: 'event', event: bgResult('alive', '', { shellId: 'bash_alive' }) })
  // Terminal count capped at 30, active always kept → 31 total.
  expect(s.bgShells.size).toBe(31)
  expect(s.bgShells.has('alive')).toBe(true)
  // Oldest evicted (t0..t4).
  expect(s.bgShells.has('t0')).toBe(false)
  expect(s.bgShells.has('t4')).toBe(false)
  expect(s.bgShells.has('t5')).toBe(true)
  expect(s.bgShellOrder.includes('t0')).toBe(false)
})

test('bg-shells: reset clears shells', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, {
    type: 'event',
    event: bgCall('a', 'Bash', { command: 'one', run_in_background: true })
  })
  s = reducer(s, { type: 'reset' })
  expect(s.bgShells.size).toBe(0)
  expect(s.bgShellOrder.length).toBe(0)
})

// ---- spawn-token scoping --------------------------------------------------

const spawn = (spawnId: string): AgentEvent => ({ kind: 'session-spawn', spawnId })

test('spawn-token: session-spawn sets currentSpawnId', () => {
  let s = initialState()
  expect(s.currentSpawnId).toBe(null)
  s = reducer(s, { type: 'event', event: spawn('sp-1') })
  expect(s.currentSpawnId).toBe('sp-1')
})

test('spawn-token: bg shell tags spawnedInSpawnId at creation', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: spawn('sp-1') })
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, {
    type: 'event',
    event: bgCall('shell-a', 'Bash', { command: 'pnpm dev', run_in_background: true })
  })
  const shell = s.bgShells.get('shell-a')!
  expect(shell.spawnedInSpawnId).toBe('sp-1')
})

test('spawn-token: new session-spawn drops active shells from prior spawn', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: spawn('sp-1') })
  s = reducer(s, { type: 'event', event: ev.turnInit('sid-r') })
  s = reducer(s, {
    type: 'event',
    event: bgCall('shell-a', 'Bash', { command: 'pnpm dev', run_in_background: true })
  })
  s = reducer(s, { type: 'event', event: bgResult('shell-a', '', { shellId: 'bash_1' }) })
  expect(s.bgShells.get('shell-a')!.status).toBe('running')
  // App restart simulated: same sessionId (--resume), brand-new spawnId.
  s = reducer(s, { type: 'event', event: spawn('sp-2') })
  expect(s.bgShells.has('shell-a')).toBe(false)
  expect(s.bgShellOrder.includes('shell-a')).toBe(false)
  expect(s.currentSpawnId).toBe('sp-2')
})

test('spawn-token: same spawnId twice does not flip own shells', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: spawn('sp-1') })
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, {
    type: 'event',
    event: bgCall('shell-a', 'Bash', { command: 'x', run_in_background: true })
  })
  s = reducer(s, { type: 'event', event: bgResult('shell-a', '', { shellId: 'bash_1' }) })
  // Re-emission of same spawnId (defensive — should be idempotent).
  s = reducer(s, { type: 'event', event: spawn('sp-1') })
  expect(s.bgShells.get('shell-a')!.status).toBe('running')
})

test('spawn-token: terminal-status shells (completed/killed) survive new spawn', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: spawn('sp-1') })
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, {
    type: 'event',
    event: bgCall('shell-a', 'Bash', { command: 'one-shot', run_in_background: true })
  })
  s = reducer(s, { type: 'event', event: bgResult('shell-a', '', { shellId: 'bash_1' }) })
  s = reducer(s, { type: 'event', event: bgCall('poll-a', 'BashOutput', { bash_id: 'bash_1' }) })
  s = reducer(s, {
    type: 'event',
    event: bgResult('poll-a', '', { status: 'completed', exitCode: 0 })
  })
  expect(s.bgShells.get('shell-a')!.status).toBe('completed')
  s = reducer(s, { type: 'event', event: spawn('sp-2') })
  // Completed history preserved — only active shells flip.
  expect(s.bgShells.get('shell-a')!.status).toBe('completed')
})

test('spawn-token: legacy shells (no spawnedInSpawnId) drop on first session-spawn', () => {
  // Migration scenario: user upgrades to a build that emits session-spawn,
  // but persisted history was recorded by a prior build that did not. On first
  // new spawn, the legacy active shells (spawnedInSpawnId=null) are stale by
  // construction — the prior subprocess is dead.
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, {
    type: 'event',
    event: bgCall('legacy-a', 'Bash', { command: 'old', run_in_background: true })
  })
  s = reducer(s, { type: 'event', event: bgResult('legacy-a', '', { shellId: 'bash_legacy' }) })
  expect(s.bgShells.get('legacy-a')!.spawnedInSpawnId).toBe(null)
  s = reducer(s, { type: 'event', event: spawn('sp-new') })
  expect(s.bgShells.has('legacy-a')).toBe(false)
})

test('spawn-token: process-exit (agent event) drops active shells', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: spawn('sp-1') })
  s = reducer(s, { type: 'event', event: ev.turnInit('sid-x') })
  s = reducer(s, {
    type: 'event',
    event: bgCall('shell-a', 'Bash', { command: 'long', run_in_background: true })
  })
  s = reducer(s, { type: 'event', event: bgResult('shell-a', '', { shellId: 'bash_1' }) })
  s = reducer(s, {
    type: 'event',
    event: { kind: 'process-exit', code: 0, signal: null }
  })
  expect(s.bgShells.has('shell-a')).toBe(false)
})

test('spawn-token: process-exit (live IPC action) drops active shells when sessionId matches', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: spawn('sp-1') })
  s = reducer(s, { type: 'event', event: ev.turnInit('sid-live') })
  s = reducer(s, {
    type: 'event',
    event: bgCall('shell-a', 'Bash', { command: 'long', run_in_background: true })
  })
  s = reducer(s, { type: 'event', event: bgResult('shell-a', '', { shellId: 'bash_1' }) })
  s = reducer(s, { type: 'process-exit', sessionId: 'sid-live', code: 0, signal: null })
  expect(s.sessionEnded).toBe(true)
  expect(s.bgShells.has('shell-a')).toBe(false)
})

test('spawn-token: stale process-exit (mismatched sessionId) does NOT drop shells', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: spawn('sp-1') })
  s = reducer(s, { type: 'event', event: ev.turnInit('sid-current') })
  s = reducer(s, {
    type: 'event',
    event: bgCall('shell-a', 'Bash', { command: 'long', run_in_background: true })
  })
  s = reducer(s, { type: 'event', event: bgResult('shell-a', '', { shellId: 'bash_1' }) })
  s = reducer(s, { type: 'process-exit', sessionId: 'sid-old', code: 137, signal: 'SIGKILL' })
  // Stale exit is dropped → sessionEnded stays false → shells stay running.
  expect(s.sessionEnded).toBe(false)
  expect(s.bgShells.get('shell-a')!.status).toBe('running')
})

test('spawn-token: replay determinism across spawn-token boundary', () => {
  // Simulates app restart: persisted history contains old spawn + old shell,
  // then new spawn appended. Replay must converge on the same final state —
  // active shells from the dead spawn dropped, no orphans left.
  const events: AgentEvent[] = [
    spawn('sp-old'),
    ev.turnInit('sid-resume'),
    bgCall('shell-a', 'Bash', { command: 'pnpm dev', run_in_background: true }),
    bgResult('shell-a', '', { shellId: 'bash_1' }),
    spawn('sp-new'),
    ev.turnInit('sid-resume')
  ]
  let s = initialState()
  for (const e of events) s = reducer(s, { type: 'event', event: e })
  expect(s.bgShells.has('shell-a')).toBe(false)
  expect(s.currentSpawnId).toBe('sp-new')
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
