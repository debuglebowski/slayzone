/**
 * Tests for chat-timeline reducer (correlation + pairing + in-flight).
 */
import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import { claudeCodeAdapter } from '../server/agents/claude-code-adapter'
import {
  initialState,
  reducer,
  isInFlight,
  isAwaitingUserQuestion,
  deriveLoadingLabel,
  selectActiveUserIds,
  selectFoldedIndexes,
  selectUsageSummary,
  type ChatTimelineState
} from './chat-timeline'
import { selectPendingPrompts, selectPromptForTool, hasPendingPrompt } from './chat-prompts'

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

// ---- Slash commands, compaction, context + cost (chat plan 3.1 / 3.4) ----

const usage = (input: number, cacheWrite: number, cacheRead: number, output = 1) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadInputTokens: cacheRead,
  cacheCreationInputTokens: cacheWrite
})

const costResult = (
  totalCostUsd: number,
  modelUsage: Extract<AgentEvent, { kind: 'result' }>['modelUsage']
): AgentEvent => ({
  ...(ev.turnResult() as Extract<AgentEvent, { kind: 'result' }>),
  totalCostUsd,
  modelUsage
})

const haiku = (costUsd: number, contextWindow = 1_000_000) => ({
  'claude-haiku-5-5': {
    inputTokens: 10,
    outputTokens: 10,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd,
    contextWindow
  }
})

const run = (events: AgentEvent[], from = initialState()) =>
  events.reduce((s, event) => reducer(s, { type: 'event', event }), from)

describe('compaction', () => {
  test('started → compacting + loading label; succeeded → cleared', () => {
    let s = run([ev.turnInit(), { kind: 'user-message', text: '/compact' }])
    s = run([{ kind: 'compact-status', phase: 'started' }], s)
    expect(s.compacting).toBe(true)
    expect(deriveLoadingLabel(s)).toBe('Compacting conversation…')
    s = run([{ kind: 'compact-status', phase: 'succeeded' }], s)
    expect(s.compacting).toBe(false)
  })

  test('boundary → divider item with trigger + pre tokens; context size becomes unknown', () => {
    const s = run([
      ev.turnInit(),
      { kind: 'user-message', text: 'hi' },
      { kind: 'assistant-text', messageId: 'm1', text: 'ok', usage: usage(10, 20, 30) },
      { kind: 'user-message', text: '/compact' },
      { kind: 'compact-status', phase: 'started' },
      { kind: 'compact-boundary', trigger: 'manual', preTokens: 49079, postTokens: 6408 }
    ])
    const items = s.timeline.filter((i) => i.kind === 'compaction')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ outcome: 'compacted', trigger: 'manual', preTokens: 49079 })
    expect(s.compacting).toBe(false)
    expect(s.usage.contextTokens).toBeNull()
  })

  test('failed → error item; the identical CLI command output is not shown twice', () => {
    const s = run([
      ev.turnInit(),
      { kind: 'user-message', text: '/compact' },
      { kind: 'compact-status', phase: 'started' },
      { kind: 'compact-status', phase: 'failed', error: 'Not enough messages to compact.' },
      {
        kind: 'command-output',
        id: 'c1',
        command: 'compact',
        text: 'Not enough messages to compact.'
      }
    ])
    const items = s.timeline.filter((i) => i.kind === 'compaction')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ outcome: 'failed', error: 'Not enough messages to compact.' })
    expect(s.timeline.some((i) => i.kind === 'command-output')).toBe(false)
    expect(s.compacting).toBe(false)
  })

  test('interrupt and process exit clear an open compaction', () => {
    const open = run([
      ev.turnInit(),
      { kind: 'user-message', text: '/compact' },
      { kind: 'compact-status', phase: 'started' }
    ])
    expect(run([{ kind: 'interrupted' }], open).compacting).toBe(false)
    expect(run([{ kind: 'process-exit', code: 1, signal: null }], open).compacting).toBe(false)
  })
})

describe('command output', () => {
  test('local command output → command-output item, part of the turn copy text', () => {
    const s = run([
      ev.turnInit(),
      { kind: 'user-message', text: '/context' },
      { kind: 'command-output', id: 'c1', command: 'context', text: '## Context Usage' },
      ev.turnResult()
    ])
    const out = s.timeline.find((i) => i.kind === 'command-output')
    expect(out).toMatchObject({ command: 'context', text: '## Context Usage' })
    expect(s.lastResult?.copyText).toBe('## Context Usage')
  })
})

describe('context + session cost', () => {
  test('context size = prompt tokens of the latest main-thread call', () => {
    const s = run([
      ev.turnInit(),
      { kind: 'user-message', text: 'hi' },
      { kind: 'assistant-text', messageId: 'm1', text: 'ok', usage: usage(8036, 40990, 0, 4) }
    ])
    expect(s.usage.contextTokens).toBe(8036 + 40990)
  })

  test('sub-agent calls do not move the main context size', () => {
    const s = run([
      ev.turnInit(),
      { kind: 'user-message', text: 'hi' },
      { kind: 'assistant-text', messageId: 'm1', text: 'ok', usage: usage(1, 2, 3) },
      {
        kind: 'tool-call',
        id: 't2',
        name: 'Read',
        input: {},
        parentToolUseId: 'task-1',
        usage: usage(500, 500, 500)
      }
    ])
    expect(s.usage.contextTokens).toBe(6)
  })

  test('cumulative totals become per-turn costs; session cost is their sum', () => {
    let s = run([
      ev.turnInit('sid-1'),
      { kind: 'user-message', text: 'a' },
      costResult(0.009, haiku(0.009))
    ])
    s = run([{ kind: 'user-message', text: 'b' }, costResult(0.011, haiku(0.011))], s)
    const results = s.timeline.filter((i) => i.kind === 'result')
    expect(results.map((r) => (r.kind === 'result' ? r.turnCostUsd : -1))).toEqual([
      0.009,
      0.011 - 0.009
    ])
    expect(s.usage.sessionCostUsd).toBeCloseTo(0.011)
    // A respawned CLI that did not restore its cost counter starts again near 0.
    s = run([{ kind: 'user-message', text: 'c' }, costResult(0.003, haiku(0.003))], s)
    expect(s.usage.sessionCostUsd).toBeCloseTo(0.014)
  })

  test('context window comes from the session model; falls back to the busiest model', () => {
    const s = run([
      { ...ev.turnInit(), model: 'claude-haiku-5-5' } as AgentEvent,
      { kind: 'user-message', text: 'a' },
      costResult(0.01, haiku(0.01, 200_000))
    ])
    expect(s.usage.contextWindow).toBe(200_000)
    const other = run([
      { ...ev.turnInit(), model: 'haiku' } as AgentEvent,
      { kind: 'user-message', text: 'a' },
      costResult(0.01, {
        small: { ...haiku(0)['claude-haiku-5-5'], inputTokens: 1, contextWindow: 100 },
        big: { ...haiku(0)['claude-haiku-5-5'], inputTokens: 9999, contextWindow: 1_000_000 }
      })
    ])
    expect(other.usage.contextWindow).toBe(1_000_000)
  })

  test('provider without per-model accounting (Codex shape) → no usage summary, footer cost unchanged', () => {
    const s = run([ev.turnInit(), { kind: 'user-message', text: 'a' }, costResult(0, {})])
    expect(selectUsageSummary(s)).toBeNull()
    const result = s.timeline.find((i) => i.kind === 'result')
    expect(result?.kind === 'result' && result.turnCostUsd).toBe(0)
  })

  test('selectUsageSummary exposes only what was reported', () => {
    const s = run([
      { ...ev.turnInit(), model: 'claude-haiku-5-5' } as AgentEvent,
      { kind: 'user-message', text: 'a' },
      { kind: 'assistant-text', messageId: 'm1', text: 'ok', usage: usage(100, 0, 0) },
      costResult(0.5, haiku(0.5))
    ])
    expect(selectUsageSummary(s)).toEqual({
      contextTokens: 100,
      contextWindow: 1_000_000,
      sessionCostUsd: 0.5
    })
  })
})

describe('CLI command list', () => {
  const init = (sessionId: string, slashCommands?: string[]): AgentEvent => ({
    ...(ev.turnInit(sessionId) as Extract<AgentEvent, { kind: 'turn-init' }>),
    slashCommands,
    terminalSlashCommands: slashCommands ? ['doctor'] : undefined,
    skills: slashCommands ? ['simplify'] : undefined,
    cliVersion: slashCommands ? '2.1.312' : undefined
  })

  test('turn-init list is kept; an identical list keeps the same reference', () => {
    const a = run([init('s1', ['compact', 'context'])])
    expect(a.cliCommands).toEqual({
      slashCommands: ['compact', 'context'],
      terminalSlashCommands: ['doctor'],
      skills: ['simplify'],
      cliVersion: '2.1.312'
    })
    const b = run([init('s1', ['compact', 'context'])], a)
    expect(b.cliCommands).toBe(a.cliCommands)
    const c = run([init('s1', ['compact'])], b)
    expect(c.cliCommands?.slashCommands).toEqual(['compact'])
  })

  test('an init without a list (Codex) keeps whatever was known (null on a fresh state)', () => {
    expect(run([init('s1')]).cliCommands).toBeNull()
    const known = run([init('s1', ['compact'])])
    expect(run([init('s1')], known).cliCommands).toBe(known.cliCommands)
  })
})

test('recorded /compact session replays to one divider, cumulative cost and the post-compact context', () => {
  const raw = readFileSync(
    fileURLToPath(
      new URL('../../test/fixtures/claude-stream/chatui-compact-session.ndjson', import.meta.url)
    ),
    'utf8'
  )
  const events = raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => claudeCodeAdapter.parseLine(l))
    .filter((e): e is AgentEvent => e !== null)
  const s = run(events)
  expect(s.timeline.filter((i) => i.kind === 'compaction')).toHaveLength(1)
  expect(s.usage.sessionCostUsd).toBeCloseTo(0.014659365)
  expect(s.usage.contextWindow).toBe(1_000_000)
  expect(s.usage.contextTokens).toBe(8036 + 2569 + 39334)
  expect(s.timeline.filter((i) => i.kind === 'command-output')).toHaveLength(1)
  expect(s.compacting).toBe(false)
})

describe('custom command errors', () => {
  test('a refused `!shell` line → error command-output named after the sent command', () => {
    const s = run([
      ev.turnInit(),
      { kind: 'user-message', text: '/y check it' },
      {
        kind: 'command-output',
        id: 'u-1',
        command: null,
        text: 'Shell command permission check failed',
        isError: true
      },
      ev.turnResult()
    ])
    const out = s.timeline.find((i) => i.kind === 'command-output')
    expect(out).toMatchObject({
      command: 'y',
      text: 'Shell command permission check failed',
      isError: true
    })
  })

  test('without a `/command` user message the error keeps a null command', () => {
    const s = run([
      ev.turnInit(),
      { kind: 'user-message', text: 'plain text' },
      { kind: 'command-output', id: 'u-1', command: null, text: 'boom', isError: true }
    ])
    expect(s.timeline.find((i) => i.kind === 'command-output')).toMatchObject({
      command: null,
      isError: true
    })
  })
})

describe('hook output + notices', () => {
  test('hook-output → hook item; notice → notice item', () => {
    const s = run([
      ev.turnInit(),
      { kind: 'user-message', text: 'go' },
      {
        kind: 'hook-output',
        hookId: 'h1',
        hookName: 'PreToolUse:Bash',
        hookEvent: 'PreToolUse',
        effect: 'blocked',
        audience: 'agent',
        text: 'Blocked by policy',
        exitCode: 2
      },
      { kind: 'notice', id: 'n1', level: 'notice', text: 'PostToolUse:Bash says: hi' }
    ])
    expect(s.timeline.find((i) => i.kind === 'hook')).toMatchObject({
      hookId: 'h1',
      hookName: 'PreToolUse:Bash',
      effect: 'blocked',
      audience: 'agent',
      text: 'Blocked by policy',
      exitCode: 2
    })
    expect(s.timeline.find((i) => i.kind === 'notice')).toMatchObject({
      id: 'n1',
      level: 'notice',
      text: 'PostToolUse:Bash says: hi'
    })
  })

  test('recorded hook session replays hooks in place, between the tool cards', () => {
    const raw = readFileSync(
      fileURLToPath(
        new URL('../../test/fixtures/claude-stream/chatui-hooks.ndjson', import.meta.url)
      ),
      'utf8'
    )
    const events = raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => claudeCodeAdapter.parseLine(l))
      .filter((e): e is AgentEvent => e !== null)
    const s = run(events)
    const order = s.timeline
      .filter((i) => i.kind === 'hook' || i.kind === 'notice' || i.kind === 'tool')
      .map((i) =>
        i.kind === 'hook'
          ? `hook:${i.hookName}:${i.effect}`
          : i.kind === 'notice'
            ? 'notice'
            : `tool:${i.invocation.status}`
      )
    expect(order).toEqual([
      'hook:SessionStart:startup:context',
      'hook:UserPromptSubmit:context',
      // The CLI lists a hook-blocked call in result.permission_denials.
      'tool:denied',
      'hook:PreToolUse:Bash:blocked',
      'tool:done',
      'hook:PostToolUse:Bash:failed',
      'notice',
      'hook:Stop:cancelled'
    ])
  })
})

// ---- Prompt model (permission requests, questions, plan approval) ----------
// Prompt state is derived from the event log only, so a reload (replay of the
// same events) rebuilds it exactly.

describe('prompt model', () => {
  const request = (requestId: string, toolUseId: string, toolName = 'Bash'): AgentEvent => ({
    kind: 'permission-request',
    requestId,
    toolName,
    toolUseId,
    input: { command: 'npm run build' },
    permissionSuggestions: [],
    description: 'Build'
  })
  function run(events: AgentEvent[]): ChatTimelineState {
    let s = initialState()
    s = reducer(s, { type: 'event', event: { kind: 'session-spawn', spawnId: 'sp1' } })
    s = reducer(s, { type: 'event', event: ev.turnInit() })
    s = reducer(s, { type: 'event', event: { kind: 'user-message', text: 'go' } })
    for (const e of events) s = reducer(s, { type: 'event', event: e })
    return s
  }

  test('a request is pending until answered; the answer is kept with it', () => {
    const pending = run([ev.call('t-1'), request('r1', 't-1')])
    expect(hasPendingPrompt(pending)).toBe(true)
    expect(selectPendingPrompts(pending).map((p) => p.requestId)).toEqual(['r1'])
    expect(selectPromptForTool(pending, 't-1')).toMatchObject({
      requestId: 'r1',
      toolName: 'Bash',
      status: 'pending',
      request: { description: 'Build' }
    })

    const answered = run([
      ev.call('t-1'),
      request('r1', 't-1'),
      {
        kind: 'permission-resolved',
        requestId: 'r1',
        decision: { behavior: 'allow' },
        optionId: 'yes'
      }
    ])
    expect(hasPendingPrompt(answered)).toBe(false)
    expect(selectPromptForTool(answered, 't-1')).toMatchObject({
      status: 'resolved',
      decision: { behavior: 'allow' },
      optionId: 'yes'
    })
  })

  test('the CLI withdrawing a request cancels it', () => {
    const s = run([request('r1', 't-1'), { kind: 'permission-cancelled', requestId: 'r1' }])
    expect(selectPromptForTool(s, 't-1')?.status).toBe('cancelled')
    expect(hasPendingPrompt(s)).toBe(false)
  })

  test('a request dies with its process: exit, respawn, interrupt → expired', () => {
    for (const end of [
      { kind: 'process-exit', code: 0, signal: null },
      { kind: 'session-spawn', spawnId: 'sp2' },
      { kind: 'interrupted' }
    ] as AgentEvent[]) {
      const s = run([request('r1', 't-1'), end])
      expect(selectPromptForTool(s, 't-1')?.status).toBe('expired')
    }
  })

  test('an answered request stays answered when the turn is interrupted (TUI "No")', () => {
    const s = run([
      request('r1', 't-1'),
      {
        kind: 'permission-resolved',
        requestId: 'r1',
        decision: { behavior: 'deny', message: 'no', interrupt: true }
      },
      { kind: 'interrupted' }
    ])
    expect(selectPromptForTool(s, 't-1')?.status).toBe('resolved')
  })

  test('older logs (no permission-resolved): the tool result marks the request answered', () => {
    const s = run([ev.call('t-1'), request('r1', 't-1'), ev.result('t-1')])
    expect(selectPromptForTool(s, 't-1')?.status).toBe('resolved')
    // Codex approvals can carry an empty tool id — never matched by id.
    const codex = run([request('c1', ''), ev.result('')])
    expect(selectPendingPrompts(codex).map((p) => p.requestId)).toEqual(['c1'])
  })

  test('replaying the same events twice does not duplicate a request', () => {
    const s = run([request('r1', 't-1'), request('r1', 't-1')])
    expect(selectPendingPrompts(s)).toHaveLength(1)
  })

  test('permission-mode-changed updates the live permission mode', () => {
    const s = run([{ kind: 'permission-mode-changed', mode: 'acceptEdits' }])
    expect(s.permissionMode).toBe('acceptEdits')
  })
})

// Stop (and a prompt's "No") persists `interrupted`, then the CLI still sends
// the aborted turn's `result`. That result must not count as the NEXT turn's.
test('a result after an interrupt does not leave the next turn looking finished', () => {
  let s = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit() })
  s = reducer(s, { type: 'event', event: { kind: 'user-message', text: 'one' } })
  s = reducer(s, { type: 'event', event: { kind: 'interrupted' } })
  const aborted = ev.turnResult()
  if (aborted.kind !== 'result') throw new Error('expected a result event')
  s = reducer(s, {
    type: 'event',
    event: { ...aborted, isError: true, subtype: 'error_during_execution' }
  })
  expect(isInFlight(s)).toBe(false)
  s = reducer(s, { type: 'event', event: { kind: 'user-message', text: 'two' } })
  expect(isInFlight(s)).toBe(true)
})

describe('outbox: delivery states on the user message', () => {
  const sent = (id: string, text = id): AgentEvent => ({
    kind: 'user-message',
    id,
    text,
    content: [{ type: 'text', text }]
  })
  const delivery = (
    id: string,
    state: 'sending' | 'delivered' | 'answered' | 'failed' | 'cancelled',
    error?: string
  ): AgentEvent => ({ kind: 'user-message-delivery', id, state, ...(error ? { error } : {}) })
  const userItems = (s: ReturnType<typeof initialState>) =>
    s.timeline.filter((i) => i.kind === 'user-text') as Array<
      Extract<ReturnType<typeof initialState>['timeline'][number], { kind: 'user-text' }>
    >

  test('the optimistic bubble is confirmed by id, then follows the delivery states', () => {
    let s = reducer(initialState(), { type: 'user-sent', id: 'm1', text: 'hi' })
    expect(userItems(s)[0]).toMatchObject({ id: 'm1', delivery: 'queued', optimistic: true })
    s = run([sent('m1', 'hi')], s)
    expect(userItems(s)).toHaveLength(1)
    expect(userItems(s)[0]).toMatchObject({ id: 'm1', optimistic: false, delivery: 'queued' })
    s = run([delivery('m1', 'sending'), delivery('m1', 'delivered')], s)
    expect(userItems(s)[0].delivery).toBe('delivered')
    s = run([delivery('m1', 'answered')], s)
    expect(userItems(s)[0].delivery).toBe('answered')
  })

  test('confirmation matches by id, not by position', () => {
    let s = reducer(initialState(), { type: 'user-sent', id: 'a', text: 'first' })
    s = reducer(s, { type: 'user-sent', id: 'b', text: 'second' })
    s = run([sent('b', 'second')], s)
    expect(userItems(s).map((i) => [i.id, i.optimistic])).toEqual([
      ['a', true],
      ['b', false]
    ])
  })

  test('a failed message keeps its bubble with the reason, and is not in flight', () => {
    let s = run([sent('m1', 'hi')])
    expect(isInFlight(s)).toBe(true)
    s = run([delivery('m1', 'failed', 'Claude Code is not installed')], s)
    expect(userItems(s)[0]).toMatchObject({
      text: 'hi',
      delivery: 'failed',
      deliveryError: 'Claude Code is not installed'
    })
    expect(isInFlight(s)).toBe(false)
  })

  test('a send the server never received fails the bubble (kept), not removed', () => {
    let s = reducer(initialState(), { type: 'user-sent', id: 'm1', text: 'hi' })
    s = reducer(s, { type: 'user-send-failed', id: 'm1', error: 'hub unreachable' })
    expect(userItems(s)[0]).toMatchObject({
      id: 'm1',
      delivery: 'failed',
      deliveryError: 'hub unreachable'
    })
    expect(isInFlight(s)).toBe(false)
  })

  test('retry puts a failed message back in flight; replay of failed → delivered balances too', () => {
    let s = run([sent('m1', 'hi'), delivery('m1', 'failed', 'x')])
    s = reducer(s, { type: 'user-retry', id: 'm1' })
    expect(userItems(s)[0].delivery).toBe('queued')
    expect(isInFlight(s)).toBe(true)
    // What a reload replays for the same story:
    const replayed = run([
      sent('m1', 'hi'),
      delivery('m1', 'failed', 'x'),
      delivery('m1', 'delivered')
    ])
    expect(isInFlight(replayed)).toBe(true)
    expect(userItems(replayed)[0].delivery).toBe('delivered')
  })

  test('legacy user-message without id still confirms FIFO', () => {
    let s = reducer(initialState(), { type: 'user-sent', text: 'old style' })
    s = run([{ kind: 'user-message', text: 'old style' }], s)
    expect(userItems(s)).toHaveLength(1)
    expect(userItems(s)[0].optimistic).toBe(false)
  })
})

describe('transport notices', () => {
  test('a notice is shown as its own line', () => {
    const s = run([
      {
        kind: 'notice',
        id: 'n-w',
        level: 'warning',
        code: 'watchdog-killed',
        text: 'Claude Code stopped responding and was stopped.'
      }
    ])
    expect(s.timeline.at(-1)).toMatchObject({
      kind: 'notice',
      code: 'watchdog-killed',
      text: 'Claude Code stopped responding and was stopped.'
    })
  })

  test('after a failed resume the fresh session keeps the history above a divider', () => {
    let s = run([
      ev.turnInit('old-sid'),
      { kind: 'user-message', id: 'u0', text: 'earlier' },
      ev.text('a0', 'earlier answer'),
      {
        kind: 'result',
        subtype: 'success',
        isError: false,
        durationMs: 0,
        durationApiMs: 0,
        numTurns: 1,
        totalCostUsd: 0,
        stopReason: null,
        terminalReason: null,
        text: null,
        modelUsage: {},
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0
        },
        permissionDenials: []
      }
    ])
    s = run(
      [
        { kind: 'user-message', id: 'u1', text: 'hello again' },
        {
          kind: 'notice',
          id: 'n-r',
          level: 'warning',
          code: 'resume-failed-fresh-start',
          text: 'could not resume'
        },
        ev.turnInit('new-sid')
      ],
      s
    )
    const kinds = s.timeline.map((i) => i.kind)
    expect(kinds).toContain('text')
    expect(s.timeline.some((i) => i.kind === 'user-text' && i.text === 'hello again')).toBe(true)
    expect(kinds.filter((k) => k === 'session-start')).toHaveLength(2)
    expect(s.sessionId).toBe('new-sid')
  })

  test('an agent start failure is a problem card with its code', () => {
    const s = run([
      {
        kind: 'error',
        message: 'claude was not found on this computer’s PATH',
        detail: { code: 'cli-not-installed', binary: 'claude' }
      }
    ])
    expect(s.timeline.at(-1)).toMatchObject({
      kind: 'agent-problem',
      code: 'cli-not-installed',
      binary: 'claude'
    })
  })
})

describe('turn errors are visible', () => {
  const errorResult = (text: string | null): AgentEvent => ({
    kind: 'result',
    subtype: 'success',
    isError: true,
    durationMs: 0,
    durationApiMs: 0,
    numTurns: 1,
    totalCostUsd: 0,
    stopReason: null,
    terminalReason: null,
    text,
    modelUsage: {},
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0
    },
    permissionDenials: []
  })

  test('an error result with no reply shows its text as a turn error', () => {
    const s = run([
      { kind: 'user-message', text: 'hi' },
      errorResult('Invalid API key · Please run /login')
    ])
    expect(
      s.timeline.some(
        (i) => i.kind === 'turn-error' && i.text === 'Invalid API key · Please run /login'
      )
    ).toBe(true)
  })

  test('an error result after a reply (or without text) adds nothing', () => {
    const s = run([
      { kind: 'user-message', text: 'hi' },
      ev.text('m', 'partial answer'),
      errorResult('partial answer'),
      { kind: 'user-message', text: 'again' },
      errorResult(null)
    ])
    expect(s.timeline.some((i) => i.kind === 'turn-error')).toBe(false)
  })
})

// ---- chat A: Stop as a live interrupt ----

const userMsg = (text: string, id?: string): AgentEvent => ({
  kind: 'user-message',
  text,
  ...(id ? { id } : {})
})
const abortedResult = (): AgentEvent => ({
  kind: 'result',
  subtype: 'error_during_execution',
  isError: true,
  durationMs: 0,
  durationApiMs: 0,
  numTurns: 1,
  totalCostUsd: 0,
  stopReason: null,
  terminalReason: 'aborted_streaming',
  text: 'Request interrupted',
  modelUsage: {},
  usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  permissionDenials: []
})

test('the result of a turn the user stopped is an end, not an error: no turn-error line', () => {
  let s: ChatTimelineState = initialState()
  s = reducer(s, { type: 'event', event: userMsg('go', 'u1') })
  s = reducer(s, { type: 'event', event: { kind: 'interrupted' } })
  s = reducer(s, { type: 'event', event: abortedResult() })
  expect(s.timeline.some((it) => it.kind === 'turn-error')).toBe(false)
  const result = s.timeline.find((it) => it.kind === 'result')
  expect(result).toMatchObject({ isError: false })
  expect(isInFlight(s)).toBe(false)
})

test('user-message-popped matches by id when it has one: same text, other id → nothing is removed', () => {
  let s: ChatTimelineState = initialState()
  s = reducer(s, { type: 'event', event: userMsg('same', 'u1') })
  s = reducer(s, { type: 'event', event: { kind: 'user-message-popped', text: 'same', id: 'u9' } })
  expect(s.timeline.filter((it) => it.kind === 'user-text')).toHaveLength(1)
  s = reducer(s, { type: 'event', event: { kind: 'user-message-popped', text: 'same', id: 'u1' } })
  expect(s.timeline.filter((it) => it.kind === 'user-text')).toHaveLength(0)
  expect(isInFlight(s)).toBe(false)
})

test('a message Claude Code already had closes its turn with its reason', () => {
  let s: ChatTimelineState = initialState()
  s = reducer(s, { type: 'event', event: userMsg('again', 'u1') })
  expect(isInFlight(s)).toBe(true)
  s = reducer(s, {
    type: 'event',
    event: { kind: 'interrupted', reason: 'already-in-conversation' }
  })
  expect(isInFlight(s)).toBe(false)
  expect(s.timeline.at(-1)).toMatchObject({
    kind: 'interrupted',
    reason: 'already-in-conversation'
  })
})

// ---- chat A: conversation branches (rewind, fork, switch) ----

const answer = (s: ChatTimelineState, text: string): ChatTimelineState => {
  let n = reducer(s, { type: 'event', event: ev.text(`m-${text}`, text) })
  n = reducer(n, { type: 'event', event: ev.turnResult() })
  return n
}

test('rewound: the fold hides the forgotten message and everything after it', () => {
  let s: ChatTimelineState = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit('sid-1') })
  s = reducer(s, { type: 'event', event: userMsg('one', 'u1') })
  s = answer(s, 'r1')
  const from = s.timeline.length
  s = reducer(s, { type: 'event', event: userMsg('two', 'u2') })
  s = answer(s, 'r2')
  const upTo = s.timeline.length
  s = reducer(s, {
    type: 'event',
    event: { kind: 'conversation-branch', reason: 'rewound', messageId: 'u2' }
  })
  const fold = s.timeline.at(-1)
  expect(fold).toMatchObject({ kind: 'conversation-branch', reason: 'rewound', hiddenFrom: from })
  expect((fold as { hiddenCount: number }).hiddenCount).toBe(upTo - from)
  expect(isInFlight(s)).toBe(false)
})

test('forked: what followed the fork point is folded; the new conversation id does not wipe the timeline', () => {
  let s: ChatTimelineState = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit('sid-1') })
  s = reducer(s, { type: 'event', event: userMsg('one', 'u1') })
  s = answer(s, 'r1')
  const nextTurn = s.timeline.length
  s = reducer(s, { type: 'event', event: userMsg('two', 'u2') })
  s = answer(s, 'r2')
  s = reducer(s, {
    type: 'event',
    event: {
      kind: 'conversation-branch',
      reason: 'forked',
      messageId: 'u1',
      conversationId: 'sid-2'
    }
  })
  expect(s.timeline.at(-1)).toMatchObject({ reason: 'forked', hiddenFrom: nextTurn })
  s = reducer(s, { type: 'event', event: ev.turnInit('sid-2') })
  expect(s.timeline.some((it) => it.kind === 'user-text' && it.text === 'one')).toBe(true)
  expect(s.sessionId).toBe('sid-2')
})

test('fork-failed: the fork is undone — nothing folded, the same conversation goes on', () => {
  let s: ChatTimelineState = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit('sid-1') })
  s = reducer(s, { type: 'event', event: userMsg('one', 'u1') })
  s = answer(s, 'r1')
  s = reducer(s, { type: 'event', event: userMsg('two', 'u2') })
  s = answer(s, 'r2')
  s = reducer(s, {
    type: 'event',
    event: {
      kind: 'conversation-branch',
      reason: 'forked',
      messageId: 'u1',
      conversationId: 'sid-2'
    }
  })
  const forkAt = s.timeline.length - 1
  s = reducer(s, {
    type: 'event',
    event: { kind: 'conversation-branch', reason: 'fork-failed', conversationId: 'sid-1' }
  })
  // The fork's row says it failed and folds nothing; no second row.
  expect(s.timeline).toHaveLength(forkAt + 1)
  expect(s.timeline[forkAt]).toMatchObject({ reason: 'fork-failed', hiddenCount: 0 })
  expect(selectFoldedIndexes(s.timeline).size).toBe(0)
  expect(selectActiveUserIds(s.timeline)).toEqual(['u1', 'u2'])
  // The original goes on: its turn-init is a restart, nothing is kept pending.
  expect(s.freshStartPending).toBe(false)
})

test('switched: the previous conversation is folded; imported history is answered, never in flight', () => {
  let s: ChatTimelineState = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit('sid-1') })
  s = reducer(s, { type: 'event', event: userMsg('old', 'u1') })
  s = answer(s, 'r1')
  const before = s.timeline.length
  s = reducer(s, {
    type: 'event',
    event: {
      kind: 'conversation-branch',
      reason: 'switched',
      conversationId: 'sid-9',
      source: 'terminal'
    }
  })
  expect(s.timeline.at(-1)).toMatchObject({
    reason: 'switched',
    hiddenFrom: 0,
    hiddenCount: before
  })
  s = reducer(s, {
    type: 'event',
    event: { kind: 'user-message', text: 'from the TUI', id: 'h1', history: true }
  })
  s = reducer(s, { type: 'event', event: ev.text('h-a', 'tui answer') })
  expect(isInFlight(s)).toBe(false)
  expect(
    s.timeline.find((it) => it.kind === 'user-text' && it.text === 'from the TUI')
  ).toMatchObject({
    id: 'h1',
    delivery: 'answered'
  })
  s = reducer(s, { type: 'event', event: ev.turnInit('sid-9') })
  expect(s.timeline.some((it) => it.kind === 'user-text' && it.text === 'from the TUI')).toBe(true)
  // A second switch folds only what came after the first.
  const second = s.timeline.length
  s = reducer(s, {
    type: 'event',
    event: {
      kind: 'conversation-branch',
      reason: 'switched',
      conversationId: 'sid-3',
      source: 'sessions'
    }
  })
  expect(s.timeline.at(-1)).toMatchObject({
    hiddenFrom: before + 1,
    hiddenCount: second - before - 1
  })
})

test('selectActiveUserIds: messages still in the conversation (folds and history honoured)', () => {
  let s: ChatTimelineState = initialState()
  s = reducer(s, { type: 'event', event: ev.turnInit('sid-1') })
  s = reducer(s, { type: 'event', event: userMsg('one', 'u1') })
  s = answer(s, 'r1')
  s = reducer(s, { type: 'event', event: userMsg('two', 'u2') })
  s = answer(s, 'r2')
  s = reducer(s, { type: 'event', event: userMsg('legacy') })
  s = answer(s, 'r3')
  expect([...selectActiveUserIds(s.timeline)]).toEqual(['u1', 'u2'])
  s = reducer(s, {
    type: 'event',
    event: { kind: 'conversation-branch', reason: 'rewound', messageId: 'u2' }
  })
  expect([...selectActiveUserIds(s.timeline)]).toEqual(['u1'])
  s = reducer(s, {
    type: 'event',
    event: {
      kind: 'conversation-branch',
      reason: 'switched',
      conversationId: 'x',
      source: 'sessions'
    }
  })
  s = reducer(s, {
    type: 'event',
    event: { kind: 'user-message', text: 'h', id: 'h1', history: true }
  })
  expect([...selectActiveUserIds(s.timeline)]).toEqual(['h1'])
})
