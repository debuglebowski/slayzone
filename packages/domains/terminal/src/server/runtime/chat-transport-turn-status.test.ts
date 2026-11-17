/**
 * `getTurnStatus` — the one read a caller outside the computer (REST `slay chat
 * wait/status/prompts`) needs to tell "turn finished" from "parked on a prompt":
 * both read `idle`, only the transport's pending-prompt set and outbox know the
 * difference. Driven through the real transport with fake children.
 */
import { afterEach, expect, test } from 'vitest'
import { reduceChatLifecycle } from '../../shared/chat-lifecycle'
import * as mgr from './chat-transport-manager'
import {
  emitLine,
  sendAndStart,
  sj,
  startTab,
  TAB_OPTS,
  transportHarness,
  until
} from './chat-transport-testkit'

afterEach(() => {
  mgr.__resetForTests()
  mgr.resetTransportDeps()
})

test('an unknown tab has no turn status', () => {
  transportHarness()
  expect(mgr.getTurnStatus('nope')).toBeNull()
})

test('a fresh idle tab: no open turn, no prompts', async () => {
  transportHarness()
  await startTab()
  expect(mgr.getTurnStatus(TAB_OPTS.tabId)).toEqual({
    state: 'idle',
    turnOpen: false,
    pendingRequestIds: [],
    outboxInFlight: 0
  })
})

test('a prompt parks the turn: idle state, but the turn stays open with its request id', async () => {
  const h = transportHarness()
  await startTab()
  const f = h.fakes[0]
  await sendAndStart(f, 'u1')
  emitLine(f, sj.toolUse('t1'))
  emitLine(f, sj.toolUse('t2'))
  emitLine(f, sj.canUseTool('p1', 't1'))
  emitLine(f, sj.canUseTool('p2', 't2'))
  await until(() => h.savedKinds().filter((k) => k === 'permission-request').length === 2)

  const parked = mgr.getTurnStatus(TAB_OPTS.tabId)!
  expect(parked.state).toBe('idle')
  expect(parked.turnOpen).toBe(true)
  expect(parked.pendingRequestIds).toEqual(['p1', 'p2'])

  mgr.respondToPermissionRequest(TAB_OPTS.tabId, {
    requestId: 'p1',
    decision: { behavior: 'allow', updatedInput: {} }
  })
  mgr.respondToPermissionRequest(TAB_OPTS.tabId, {
    requestId: 'p2',
    decision: { behavior: 'allow', updatedInput: {} }
  })
  await until(() => mgr.getTurnStatus(TAB_OPTS.tabId)!.pendingRequestIds.length === 0)
  expect(mgr.getTurnStatus(TAB_OPTS.tabId)!.state).toBe('running')

  emitLine(f, sj.success())
  emitLine(f, sj.lifecycle('u1', 'completed'))
  await until(() => !mgr.getTurnStatus(TAB_OPTS.tabId)!.turnOpen)
  expect(mgr.getTurnStatus(TAB_OPTS.tabId)).toMatchObject({
    state: 'idle',
    pendingRequestIds: [],
    outboxInFlight: 0
  })
})

// The server's turn status also travels to clients, live, on the chat's event
// stream (`turn-status`): ordered with the rows it describes, kept for a viewer
// attaching later. Authoritative only when this computer runs
// `SLAYZONE_CHAT_LIFECYCLE=authoritative` (or the session was hydrated so).
const statuses = (h: ReturnType<typeof transportHarness>) =>
  h.broadcasts.flatMap((b) => (b.event.kind === 'turn-status' ? [b.event] : []))

test('every change of the turn status is published live, with rising revisions', async () => {
  const h = transportHarness()
  await startTab()
  const f = h.fakes[0]
  await sendAndStart(f, 'u1')
  emitLine(f, sj.canUseTool('p1', 't1'))
  await until(() => statuses(h).some((s) => s.pendingRequestIds.includes('p1')))
  emitLine(f, sj.success())
  emitLine(f, sj.lifecycle('u1', 'completed'))
  await until(() => mgr.isReadyForQueuedMessage(TAB_OPTS.tabId))
  await until(() => statuses(h).at(-1)?.turnOpen === false)

  const seen = statuses(h)
  expect(h.broadcasts.filter((b) => b.event.kind === 'turn-status').every((b) => b.live)).toBe(true)
  expect(seen.every((s) => s.authoritative === false)).toBe(true)
  expect(new Set(seen.map((s) => s.epoch)).size).toBe(1)
  const revisions = seen.map((s) => s.revision)
  expect(revisions).toEqual([...revisions].sort((a, b) => a - b))
  expect(new Set(revisions).size).toBe(revisions.length)
  expect(seen.some((s) => s.state === 'running' && s.turnOpen)).toBe(true)
  expect(seen.some((s) => s.state === 'idle' && s.turnOpen && s.pendingRequestIds.length)).toBe(
    true
  )
  expect(seen.at(-1)).toMatchObject({
    state: 'idle',
    reportedState: 'idle',
    turnOpen: false,
    pendingRequestIds: [],
    outboxInFlight: 0
  })
  // A viewer attaching now gets the latest status with the replay.
  const replay = await mgr.getReplay(TAB_OPTS.tabId, -1)
  expect(replay.live.events.filter((e) => e.kind === 'turn-status')).toEqual([seen.at(-1)])
})

test('an authoritative session publishes authoritative status', async () => {
  const h = transportHarness()
  await startTab({ lifecycleMode: 'authoritative' } as never)
  await sendAndStart(h.fakes[0], 'u1')
  await until(() => statuses(h).some((s) => s.turnOpen))
  expect(statuses(h).every((s) => s.authoritative)).toBe(true)
})

test('SLAYZONE_CHAT_LIFECYCLE chooses the mode of sessions hydrated without one', async () => {
  const before = process.env.SLAYZONE_CHAT_LIFECYCLE
  process.env.SLAYZONE_CHAT_LIFECYCLE = 'authoritative'
  try {
    const h = transportHarness()
    await startTab()
    await sendAndStart(h.fakes[0], 'u1')
    await until(() => statuses(h).some((s) => s.turnOpen))
    expect(statuses(h).every((s) => s.authoritative)).toBe(true)
  } finally {
    if (before === undefined) delete process.env.SLAYZONE_CHAT_LIFECYCLE
    else process.env.SLAYZONE_CHAT_LIFECYCLE = before
  }
})

// ---- authoritative: the lifecycle model is the server's status ----
// A deliberately different model shows whose status the server publishes and
// answers with: the model's in `authoritative` mode, the runtime's otherwise.
// (The real model and the runtime agree on every contract trace.)
const stuckRunning: typeof reduceChatLifecycle = (state, input) => {
  const next = reduceChatLifecycle(state, input)
  return input.signal.type === 'event' && input.signal.event.kind === 'result'
    ? { ...next, value: { ...next.value, phase: 'running' } }
    : next
}

async function finishedTurn(mode: 'shadow' | 'authoritative') {
  const h = transportHarness()
  mgr.__setLifecycleReducerForTests(stuckRunning)
  await startTab({ lifecycleMode: mode } as never)
  const f = h.fakes[0]
  await sendAndStart(f, 'u1')
  emitLine(f, sj.success())
  emitLine(f, sj.lifecycle('u1', 'completed'))
  await until(() => mgr.getTurnStatus(TAB_OPTS.tabId)?.outboxInFlight === 0)
  await mgr.__flushEventsForTests(TAB_OPTS.tabId)
  return h
}

afterEach(() => mgr.__setLifecycleReducerForTests(null))

test('authoritative: the model, not the runtime, is the status the server answers and publishes', async () => {
  const h = await finishedTurn('authoritative')
  expect(mgr.getTurnStatus(TAB_OPTS.tabId)).toMatchObject({ state: 'running', turnOpen: false })
  expect(mgr.getSessionTerminalState(TAB_OPTS.tabId)).toBe('running')
  expect(mgr.isReadyForQueuedMessage(TAB_OPTS.tabId)).toBe(false)
  expect(statuses(h).at(-1)).toMatchObject({ authoritative: true, state: 'running' })
  expect(h.states.at(-1)).toBe('running')
  // The runtime's own disagreement is still reported.
  expect(mgr.__getLifecycleShadowForTests(TAB_OPTS.tabId)?.mismatches).toBeGreaterThan(0)
})

test('shadow: the runtime stays the status; the model is only compared', async () => {
  const h = await finishedTurn('shadow')
  expect(mgr.getTurnStatus(TAB_OPTS.tabId)).toMatchObject({ state: 'idle', turnOpen: false })
  expect(mgr.isReadyForQueuedMessage(TAB_OPTS.tabId)).toBe(true)
  expect(statuses(h).at(-1)).toMatchObject({ authoritative: false, state: 'idle' })
})

test('authoritative: a model that fails hands the status back to the runtime', async () => {
  const h = transportHarness()
  mgr.__setLifecycleReducerForTests((state, input) => {
    if (input.signal.type === 'event' && input.signal.event.kind === 'result')
      throw new Error('broken model')
    return reduceChatLifecycle(state, input)
  })
  await startTab({ lifecycleMode: 'authoritative' } as never)
  const f = h.fakes[0]
  await sendAndStart(f, 'u1')
  emitLine(f, sj.success())
  emitLine(f, sj.lifecycle('u1', 'completed'))
  await until(() => mgr.isReadyForQueuedMessage(TAB_OPTS.tabId))
  expect(mgr.__getLifecycleShadowForTests(TAB_OPTS.tabId)?.disabled).toBe(true)
  expect(mgr.getTurnStatus(TAB_OPTS.tabId)).toMatchObject({ state: 'idle', turnOpen: false })
  await mgr.__flushEventsForTests(TAB_OPTS.tabId)
  expect(statuses(h).at(-1)).toMatchObject({ state: 'idle', turnOpen: false })
})

test('authoritative: the queue drains when the model reads the turn as over', async () => {
  const h = transportHarness()
  const kicks: string[] = []
  mgr.registerChatQueueDrainer((tabId) => kicks.push(tabId))
  await startTab({ lifecycleMode: 'authoritative' } as never)
  const f = h.fakes[0]
  await sendAndStart(f, 'u1')
  kicks.length = 0
  emitLine(f, sj.success())
  emitLine(f, sj.lifecycle('u1', 'completed'))
  await until(() => mgr.isReadyForQueuedMessage(TAB_OPTS.tabId))
  await until(() => kicks.length > 0)
  mgr.registerChatQueueDrainer(() => {})
})
