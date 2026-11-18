import { expect, test } from 'vitest'
import type { AgentEvent, ResultEvent } from '@slayzone/terminal-contracts'
import {
  createChatLifecycle,
  reduceChatLifecycle,
  chatLifecycleSnapshot,
  lifecycleEvent,
  type ChatLifecycleSignal
} from './chat-lifecycle'

const result = (patch: Partial<ResultEvent> = {}): ResultEvent => ({
  kind: 'result',
  subtype: 'completed',
  isError: false,
  durationMs: 0,
  durationApiMs: 0,
  numTurns: 1,
  totalCostUsd: 0,
  stopReason: null,
  terminalReason: null,
  text: null,
  modelUsage: {},
  usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  permissionDenials: [],
  ...patch
})
const prompt = (id: string): AgentEvent => ({
  kind: 'permission-request',
  requestId: id,
  toolUseId: `tool-${id}`,
  toolName: 'Bash',
  input: {}
})
const helper = (
  id: string,
  phase: Extract<AgentEvent, { kind: 'sub-agent' }>['phase'] = 'in-flight'
): AgentEvent => ({
  kind: 'sub-agent',
  toolUseId: id,
  phase,
  backgrounded: true,
  raw: null
})

function model(autonomous = true) {
  let state = createChatLifecycle('tab')
  let revision = 0
  const feed = (signal: ChatLifecycleSignal, generation = state.generation) => {
    state = reduceChatLifecycle(state, { tabId: 'tab', generation, revision: ++revision, signal })
    return chatLifecycleSnapshot(state)
  }
  const event = (event: AgentEvent, turnId?: string) =>
    feed(lifecycleEvent(event, { autonomous, turnId }))
  feed({ type: 'process-start', conversationId: 'conversation' }, 1)
  feed({ type: 'process-ready' })
  return { feed, event, state: () => state, snapshot: () => chatLifecycleSnapshot(state) }
}

test('main completion, helper work and new input are independent dimensions', () => {
  const m = model()
  m.feed({ type: 'turn-start', turnId: 'T1', origin: 'user' })
  m.event(helper('H1'))
  expect(m.event(result(), 'T1')).toMatchObject({
    state: 'idle',
    reportedState: 'background',
    turnOpen: false
  })
  expect(
    m.event({ kind: 'tool-call', id: 'child-tool', name: 'Bash', input: {}, parentToolUseId: 'H1' })
  ).toMatchObject({
    state: 'idle',
    reportedState: 'background',
    turnOpen: false,
    readyForMessage: true
  })
  m.feed({ type: 'turn-start', turnId: 'T2', origin: 'user' })
  expect(m.event(helper('H1', 'completed'))).toMatchObject({ state: 'running', turnOpen: true })
  expect(m.event(result(), 'T1')).toMatchObject({ state: 'running', main: { id: 'T2' } })
  expect(m.event(result(), 'T2')).toMatchObject({ state: 'idle', main: null })
})

test('prompts outrank activity until every answer or withdrawal', () => {
  const m = model()
  m.feed({ type: 'turn-start', turnId: 'T1', origin: 'user' })
  m.event(prompt('P1'))
  m.event(prompt('P2'))
  expect(m.event({ kind: 'tool-call', id: 'parallel', name: 'Bash', input: {} })).toMatchObject({
    state: 'idle',
    turnOpen: true,
    pendingRequestIds: ['P1', 'P2'],
    readyForMessage: false
  })
  expect(
    m.event({ kind: 'permission-resolved', requestId: 'P1', decision: { behavior: 'allow' } })
  ).toMatchObject({ state: 'idle', pendingRequestIds: ['P2'] })
  expect(m.event({ kind: 'permission-cancelled', requestId: 'P2' })).toMatchObject({
    state: 'idle'
  })
  expect(m.event({ kind: 'assistant-text', messageId: 'resume', text: 'continued' })).toMatchObject(
    { state: 'running', pendingRequestIds: [] }
  )
})

test('a background prompt remains visible without fabricating a main turn', () => {
  const m = model()
  m.event(helper('H1'))
  expect(m.event(prompt('child-approval'))).toMatchObject({
    state: 'idle',
    main: null,
    turnOpen: true,
    readyForMessage: false,
    pendingRequestIds: ['child-approval'],
    backgroundHelpers: 1
  })
  expect(
    m.event({
      kind: 'permission-resolved',
      requestId: 'child-approval',
      decision: { behavior: 'allow' }
    })
  ).toMatchObject({ state: 'idle', main: null, reportedState: 'background', turnOpen: false })
})

test('a late answer to an expired prompt cannot reopen the turn', () => {
  const m = model()
  m.feed({ type: 'turn-start', turnId: 'T1', origin: 'user' })
  m.event(prompt('P1'))
  m.event(result(), 'T1')
  expect(
    m.event({ kind: 'permission-resolved', requestId: 'P1', decision: { behavior: 'allow' } })
  ).toMatchObject({ state: 'idle', main: null, pendingRequestIds: [] })
})

test('Stop keeps execution and background work separate until the provider settles', () => {
  const m = model()
  m.feed({ type: 'turn-start', turnId: 'T1', origin: 'user' })
  m.event(helper('H1'))
  expect(m.event({ kind: 'interrupted', reason: 'stop-request' })).toMatchObject({
    state: 'running',
    main: { id: 'T1', stopping: true },
    backgroundHelpers: 1
  })
  expect(m.event(result({ isError: true, terminalReason: 'aborted_tools' }), 'T1')).toMatchObject({
    state: 'idle',
    reportedState: 'background',
    main: null
  })
})

test('the outbox is a separate authority, not inferred from turn completion', () => {
  const m = model()
  m.feed({ type: 'outbox', inFlight: 1 })
  m.feed({ type: 'turn-start', turnId: 'T1', origin: 'user' })
  expect(m.event(result(), 'T1')).toMatchObject({
    state: 'idle',
    turnOpen: true,
    readyForMessage: false
  })
  expect(m.feed({ type: 'outbox', inFlight: 0 })).toMatchObject({
    turnOpen: false,
    readyForMessage: true
  })
})

test('session metadata never starts a turn; autonomous starts follow provider capability', () => {
  for (const autonomous of [false, true]) {
    const m = model(autonomous)
    expect(
      m.event({ kind: 'turn-init', sessionId: 'conversation', model: 'm', cwd: '/', tools: [] })
    ).toMatchObject({ state: 'idle', main: null })
    const s = m.event({ kind: 'assistant-text', messageId: 'a', text: 'synthetic' })
    expect(s.state).toBe(autonomous ? 'running' : 'idle')
    expect(s.main?.origin ?? null).toBe(autonomous ? 'agent' : null)
  }
})

test('old revisions and old generations cannot change a replacement process', () => {
  const m = model()
  m.feed({ type: 'turn-start', turnId: 'T1', origin: 'user' })
  const old = m.state()
  m.feed({ type: 'process-start', conversationId: 'new-conversation' }, 2)
  m.feed({ type: 'process-ready' })
  m.feed({ type: 'turn-start', turnId: 'T2', origin: 'user' })
  const current = m.state()
  for (const signal of [
    lifecycleEvent(result(), { autonomous: false, turnId: 'T1' }),
    { type: 'process-ended' } as const
  ]) {
    expect(
      reduceChatLifecycle(current, { tabId: 'tab', generation: 1, revision: 100, signal })
    ).toBe(current)
  }
  expect(
    reduceChatLifecycle(current, {
      tabId: 'tab',
      generation: 2,
      revision: old.revision,
      signal: { type: 'process-ended' }
    })
  ).toBe(current)
  expect(
    reduceChatLifecycle(current, {
      tabId: 'another-tab',
      generation: 2,
      revision: 100,
      signal: { type: 'process-ended' }
    })
  ).toBe(current)
})

test('ending or replacing a process clears its work and refuses late activity', () => {
  const m = model()
  m.feed({ type: 'turn-start', turnId: 'T1', origin: 'user' })
  m.event(prompt('P1'))
  m.event(helper('H1'))
  expect(m.feed({ type: 'process-ended' })).toMatchObject({
    state: 'dead',
    main: null,
    pendingRequestIds: [],
    backgroundHelpers: 0
  })
  expect(m.event({ kind: 'tool-call', id: 'late', name: 'Bash', input: {} })).toMatchObject({
    state: 'dead',
    main: null
  })
  for (const signal of [
    { type: 'turn-cancel' },
    { type: 'process-error' },
    { type: 'process-ready' },
    { type: 'turn-start', turnId: 'late', origin: 'user' }
  ] satisfies ChatLifecycleSignal[]) {
    expect(m.feed(signal)).toMatchObject({ state: 'dead', main: null })
  }
  expect(m.feed({ type: 'process-start', conversationId: 'conversation' }, 2)).toMatchObject({
    state: 'starting'
  })
  expect(m.feed({ type: 'process-ready' })).toMatchObject({ state: 'idle', backgroundHelpers: 0 })
})

test('invalid generation and revision values cannot poison the lifecycle fence', () => {
  const m = model()
  const current = m.state()
  for (const patch of [
    { generation: Number.NaN },
    { generation: Number.POSITIVE_INFINITY },
    { generation: -1 },
    { revision: Number.NaN },
    { revision: Number.POSITIVE_INFINITY },
    { revision: -1 }
  ]) {
    expect(
      reduceChatLifecycle(current, {
        tabId: 'tab',
        generation: 2,
        revision: 100,
        signal: { type: 'process-start', conversationId: 'bad' },
        ...patch
      })
    ).toBe(current)
  }
})

test('replay is deterministic and never mutates an earlier state', () => {
  let state = createChatLifecycle('tab')
  const before = state
  const signals: ChatLifecycleSignal[] = [
    { type: 'process-start', conversationId: 'c' },
    { type: 'process-ready' },
    { type: 'turn-start', turnId: 'T1', origin: 'user' },
    lifecycleEvent(helper('H1'), { autonomous: true }),
    lifecycleEvent(result(), { autonomous: true, turnId: 'T1' })
  ]
  const inputs = signals.map((signal, i) => ({
    tabId: 'tab',
    generation: 1,
    revision: i + 1,
    signal
  }))
  for (const input of inputs) state = reduceChatLifecycle(state, input)
  expect(chatLifecycleSnapshot(before)).toMatchObject({
    state: 'not-spawned',
    main: null,
    backgroundHelpers: 0
  })
  expect(
    chatLifecycleSnapshot(inputs.reduce(reduceChatLifecycle, createChatLifecycle('tab')))
  ).toEqual(chatLifecycleSnapshot(state))
})

test('snapshots cannot mutate the model through shared turn or prompt references', () => {
  const m = model()
  m.feed({ type: 'turn-start', turnId: 'T1', origin: 'user' })
  m.event(prompt('P1'))
  const snapshot = m.snapshot()
  Reflect.set(snapshot.main!, 'id', 'changed externally')
  snapshot.pendingRequestIds.push('external prompt')
  expect(m.snapshot()).toMatchObject({ main: { id: 'T1' }, pendingRequestIds: ['P1'] })
})

test('provider event ownership binds to its host request and fences a delayed completion', () => {
  const m = model()
  const first = { turnId: 'native-1', source: 'provider' as const, messageId: 'request-1' }
  const second = { turnId: 'native-2', source: 'provider' as const, messageId: 'request-2' }
  m.feed({ type: 'turn-start', turnId: 'request-1', origin: 'user' })
  m.event({ kind: 'turn-started', execution: first })
  m.event({ ...result(), execution: first })
  m.feed({ type: 'turn-start', turnId: 'request-2', origin: 'user' })
  m.event({ kind: 'turn-started', execution: second })
  expect(m.event({ ...prompt('old-approval'), execution: first }).pendingRequestIds).toEqual([])
  expect(m.event({ ...result(), execution: first })).toMatchObject({
    state: 'running',
    main: { id: 'request-2' }
  })
  expect(m.event({ ...result(), execution: second })).toMatchObject({ state: 'idle', main: null })
})

test('an explicit replacement start retires an abandoned request without waiting for its result', () => {
  const m = model()
  m.feed({ type: 'turn-start', turnId: 'A', origin: 'user' })
  m.feed({ type: 'turn-start', turnId: 'B', origin: 'user' })
  expect(m.event(result(), 'A')).toMatchObject({ state: 'running', main: { id: 'B' } })
})

test('a process being stopped only ends: nothing it says moves its phase but to dead', () => {
  let state = createChatLifecycle('tab')
  let revision = 0
  const feed = (signal: ChatLifecycleSignal, generation = state.generation) => {
    state = reduceChatLifecycle(state, { tabId: 'tab', generation, revision: ++revision, signal })
    return chatLifecycleSnapshot(state)
  }
  feed({ type: 'process-start', conversationId: 'c' }, 1)
  expect(feed({ type: 'process-ready' })).toMatchObject({ readyForMessage: true })
  feed({ type: 'process-start', conversationId: 'c' }, 2)
  feed({ type: 'process-stopping' })
  expect(feed({ type: 'process-ready' })).toMatchObject({ state: 'starting' })
  expect(feed({ type: 'turn-start', turnId: 'T', origin: 'user' })).toMatchObject({
    state: 'starting',
    turnOpen: false
  })
  expect(feed({ type: 'process-ended' })).toMatchObject({ state: 'dead' })
  // The next process is not stopping.
  feed({ type: 'process-start', conversationId: 'c' }, 3)
  expect(feed({ type: 'process-ready' })).toMatchObject({ state: 'idle' })
})

test('a fast turn that ended before its id was bound is still its request’s end', () => {
  const m = model()
  m.feed({ type: 'turn-start', turnId: 'm1', origin: 'user' })
  const end = {
    ...result(),
    execution: { turnId: 'native-1', source: 'provider' as const, messageId: 'm1' }
  }
  expect(m.event(end)).toMatchObject({ state: 'idle', main: null })
  m.feed({ type: 'turn-start', turnId: 'm2', origin: 'user' })
  const other = {
    ...result(),
    execution: { turnId: 'native-0', source: 'provider' as const, messageId: 'm0' }
  }
  expect(m.event(other)).toMatchObject({ state: 'running', main: { id: 'm2' } })
})
