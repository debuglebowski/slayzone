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
