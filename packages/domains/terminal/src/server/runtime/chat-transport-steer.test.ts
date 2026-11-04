/**
 * "Send now": a queued message written into the RUNNING turn. The
 * agent takes it after its current tool call (Claude Code 2.1.317: `command_lifecycle
 * queued` on the write, replay + `started` after the next tool_result, one result
 * for the turn). Until the pickup the message stays in the queue — no timeline row,
 * no outbox entry; at the pickup its row lands in the turn, where the agent took it.
 * Anything that ends before the pickup gives the message back to the queue.
 */
import { afterEach, expect, test } from 'vitest'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import * as mgr from './chat-transport-manager'
import {
  emitLine,
  sendAndStart,
  sj,
  startTab,
  TAB_OPTS,
  transportHarness,
  until,
  wait
} from './chat-transport-testkit'

const TAB = TAB_OPTS.tabId
const text = (t: string) => [{ type: 'text' as const, text: t }]
const replay = (uuid: string, t: string) => ({
  type: 'user',
  uuid,
  isReplay: true,
  message: { role: 'user', content: text(t) }
})

const outcomes: Array<{ tabId: string; id: string; outcome: string }> = []

afterEach(() => {
  outcomes.length = 0
  mgr.__resetForTests()
  mgr.resetTransportDeps()
})

async function runningTurn() {
  const h = transportHarness()
  mgr.registerSteerListener((tabId, id, outcome) => outcomes.push({ tabId, id, outcome }))
  await startTab()
  const f = h.fakes[0]
  await sendAndStart(f, 'u1', 'run the build')
  emitLine(f, sj.init('s'))
  emitLine(f, sj.toolUse('tool-1'))
  await until(() => h.savedKinds().includes('tool-call'))
  return { h, f }
}

const userRows = (saved: AgentEvent[]) =>
  saved.filter((e): e is Extract<AgentEvent, { kind: 'user-message' }> => e.kind === 'user-message')

test('a steered message is written at once and shown only when the agent picks it up', async () => {
  const { h, f } = await runningTurn()
  expect(mgr.canSteer(TAB)).toBe(true)

  const result = await mgr.steerUserMessage(TAB, { id: 's1', content: text('also run lint') })

  expect(result).toEqual({ ok: true })
  await f.written((m) => m.type === 'user' && m.uuid === 's1')
  emitLine(f, sj.lifecycle('s1', 'queued'))
  await wait(10)
  // Held by the CLI: still the queue's, not the timeline's.
  expect(userRows(h.saved()).map((e) => e.id)).toEqual(['u1'])
  expect(mgr.__getOutboxStateForTests(TAB, 's1')).toBeNull()
  expect(outcomes).toEqual([])

  emitLine(f, sj.lifecycle('s1', 'started'))
  await until(() => outcomes.length === 1)

  expect(outcomes).toEqual([{ tabId: TAB, id: 's1', outcome: 'picked-up' }])
  // Its row lands in the running turn, after the tool call it followed.
  const kinds = h.savedKinds()
  expect(kinds.lastIndexOf('user-message')).toBeGreaterThan(kinds.indexOf('tool-call'))
  expect(userRows(h.saved()).at(-1)).toMatchObject({
    id: 's1',
    text: 'also run lint',
    joinsTurn: true
  })
  expect(mgr.__getOutboxStateForTests(TAB, 's1')).toBe('delivered')
  expect(mgr.getSessionTerminalState(TAB)).toBe('running')

  emitLine(f, sj.text('done'))
  emitLine(f, sj.lifecycle('s1', 'completed'))
  emitLine(f, sj.success())
  emitLine(f, sj.lifecycle('u1', 'completed'))
  await until(() => mgr.getSessionTerminalState(TAB) === 'idle')
  expect(mgr.__getOutboxStateForTests(TAB, 's1')).toBe('answered')
  expect(mgr.__getOutboxStateForTests(TAB, 'u1')).toBe('answered')
  expect(mgr.isReadyForQueuedMessage(TAB)).toBe(true)
})

test('the replay counts as the pickup when it comes before `started`', async () => {
  const { h, f } = await runningTurn()
  await mgr.steerUserMessage(TAB, { id: 's1', content: text('also run lint') })
  emitLine(f, replay('s1', 'also run lint'))
  await until(() => outcomes.length === 1)
  emitLine(f, sj.lifecycle('s1', 'started'))
  await wait(10)
  expect(outcomes).toEqual([{ tabId: TAB, id: 's1', outcome: 'picked-up' }])
  expect(userRows(h.saved()).filter((e) => e.id === 's1')).toHaveLength(1)
})

test('no running turn, or a prompt waiting: nothing to add to', async () => {
  const h = transportHarness()
  await startTab()
  const f = h.fakes[0]
  expect(mgr.canSteer(TAB)).toBe(false)
  expect(await mgr.steerUserMessage(TAB, { id: 's1', content: text('x') })).toMatchObject({
    ok: false
  })

  await sendAndStart(f, 'u1')
  emitLine(f, sj.canUseTool('r1', 'tool-1'))
  await until(() => mgr.isSessionAwaitingUserInput(TAB))
  expect(mgr.canSteer(TAB)).toBe(false)
  expect(await mgr.steerUserMessage(TAB, { id: 's2', content: text('x') })).toMatchObject({
    ok: false
  })
  expect(f.stdin.filter((m) => m.type === 'user').map((m) => m.uuid)).toEqual(['u1'])
})

test('withdraw before the pickup: the CLI cancels it and it goes back to the queue', async () => {
  const { h, f } = await runningTurn()
  f.answer('cancel_async_message', () => ({ success: { cancelled: true } }))
  await mgr.steerUserMessage(TAB, { id: 's1', content: text('also run lint') })
  emitLine(f, sj.lifecycle('s1', 'queued'))

  expect(await mgr.withdrawSteer(TAB, 's1')).toBe(true)

  expect(f.controlRequests('cancel_async_message')).toEqual([
    { subtype: 'cancel_async_message', message_uuid: 's1' }
  ])
  expect(outcomes).toEqual([{ tabId: TAB, id: 's1', outcome: 'returned' }])
  // Its late lifecycle changes nothing.
  emitLine(f, sj.lifecycle('s1', 'cancelled'))
  await wait(10)
  expect(outcomes).toHaveLength(1)
  expect(userRows(h.saved()).map((e) => e.id)).toEqual(['u1'])
})

test('withdraw after the pickup is refused: the agent has it', async () => {
  const { f } = await runningTurn()
  await mgr.steerUserMessage(TAB, { id: 's1', content: text('also run lint') })
  emitLine(f, sj.lifecycle('s1', 'started'))
  await until(() => outcomes.length === 1)
  expect(await mgr.withdrawSteer(TAB, 's1')).toBe(false)
  expect(f.controlRequests('cancel_async_message')).toEqual([])
})

test('the CLI dropping it (`cancelled`) gives it back', async () => {
  const { f } = await runningTurn()
  await mgr.steerUserMessage(TAB, { id: 's1', content: text('also run lint') })
  emitLine(f, sj.lifecycle('s1', 'cancelled'))
  await until(() => outcomes.length === 1)
  expect(outcomes).toEqual([{ tabId: TAB, id: 's1', outcome: 'returned' }])
})

test('the process ending before the pickup gives it back', async () => {
  const { f } = await runningTurn()
  await mgr.steerUserMessage(TAB, { id: 's1', content: text('also run lint') })
  f.exit(1)
  await until(() => outcomes.length === 1)
  expect(outcomes).toEqual([{ tabId: TAB, id: 's1', outcome: 'returned' }])
})

test('Stop withdraws a steered message first: it stays queued instead of running after the stop', async () => {
  const { f } = await runningTurn()
  f.answer('cancel_async_message', () => ({ success: { cancelled: true } }))
  f.answer('interrupt', () => {
    setImmediate(() => emitLine(f, sj.aborted('aborted_tools')))
    return { success: { still_queued: [] } }
  })
  await mgr.steerUserMessage(TAB, { id: 's1', content: text('also run lint') })
  emitLine(f, sj.lifecycle('s1', 'queued'))

  await mgr.stopTurn(TAB, { restorePrompt: false, respawnOpts: async () => ({ ...TAB_OPTS }) })

  expect(f.controlSubtypes()).toEqual(['cancel_async_message', 'interrupt'])
  expect(outcomes).toEqual([{ tabId: TAB, id: 's1', outcome: 'returned' }])
})

test('a steer the CLI holds past the end of the turn runs as the next turn when picked up', async () => {
  const { h, f } = await runningTurn()
  await mgr.steerUserMessage(TAB, { id: 's1', content: text('also run lint') })
  emitLine(f, sj.lifecycle('s1', 'queued'))
  emitLine(f, sj.text('done'))
  emitLine(f, sj.success())
  emitLine(f, sj.lifecycle('u1', 'completed'))
  await until(() => mgr.getSessionTerminalState(TAB) === 'idle')
  expect(outcomes).toEqual([])

  emitLine(f, sj.lifecycle('s1', 'started'))
  await until(() => outcomes.length === 1)
  expect(mgr.getSessionTerminalState(TAB)).toBe('running')
  // Its own turn: an ordinary user message.
  expect(userRows(h.saved()).at(-1)).toMatchObject({ id: 's1' })
  expect(userRows(h.saved()).at(-1)?.joinsTurn).toBeUndefined()
  // The answer of that turn answers it.
  emitLine(f, sj.text('lint ok'))
  emitLine(f, sj.success())
  emitLine(f, sj.lifecycle('s1', 'completed'))
  await until(() => mgr.__getOutboxStateForTests(TAB, 's1') === 'answered')
})

test('after a Stop, the next turn takes "Send now" again; while the stop is in flight it does not', async () => {
  const { f } = await runningTurn()
  f.answer('interrupt', () => 'ignore')

  const stopping = mgr.stopTurn(TAB, {
    restorePrompt: false,
    respawnOpts: async () => ({ ...TAB_OPTS })
  })
  const interrupt = await f.written(
    (m) =>
      m.type === 'control_request' &&
      (m.request as Record<string, unknown> | undefined)?.subtype === 'interrupt'
  )
  await wait(10)
  // The interrupt is not acknowledged yet: the turn still runs, but it is being stopped.
  expect(mgr.getSessionTerminalState(TAB)).toBe('running')
  expect(mgr.canSteer(TAB)).toBe(false)
  expect(await mgr.steerUserMessage(TAB, { id: 's0', content: text('x') })).toMatchObject({
    ok: false
  })

  emitLine(f, {
    type: 'control_response',
    response: { subtype: 'success', request_id: interrupt.request_id, response: {} }
  })
  emitLine(f, sj.aborted('aborted_tools'))
  expect(await stopping).toMatchObject({ via: 'interrupt' })
  await until(() => mgr.getSessionTerminalState(TAB) === 'idle')

  // The process stayed; its next turn is an ordinary running turn.
  await sendAndStart(f, 'u2', 'next')
  expect(mgr.getSessionTerminalState(TAB)).toBe('running')
  expect(mgr.canSteer(TAB)).toBe(true)
  expect(await mgr.steerUserMessage(TAB, { id: 's1', content: text('also run lint') })).toEqual({
    ok: true
  })
  await f.written((m) => m.type === 'user' && m.uuid === 's1')
})
