/**
 * `getTurnStatus` — the one read a caller outside the computer (REST `slay chat
 * wait/status/prompts`) needs to tell "turn finished" from "parked on a prompt":
 * both read `idle`, only the transport's pending-prompt set and outbox know the
 * difference. Driven through the real transport with fake children.
 */
import { afterEach, expect, test } from 'vitest'
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
