/**
 * Chat A — Stop is a live interrupt (plan 3.x "Stop / Esc = real interrupt") and
 * the queue gate counts pending prompts (P2 open item). Driven through the real
 * transport with fake children answering the host's control requests the way
 * Claude Code 2.1.312 does (spike items 3 + 14, chat-a checks R4).
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
  until,
  wait
} from './chat-transport-testkit'

const respawnOpts = async () => ({ ...TAB_OPTS })
const stop = (restorePrompt: boolean, interruptTimeoutMs = 300) =>
  mgr.stopTurn(TAB_OPTS.tabId, { restorePrompt, respawnOpts, interruptTimeoutMs })

afterEach(() => {
  mgr.__resetForTests()
  mgr.resetTransportDeps()
})

test('Stop mid-turn sends a live interrupt and keeps the process', async () => {
  const h = transportHarness()
  await startTab()
  const f = h.fakes[0]
  f.answer('interrupt', () => {
    // The CLI ends the turn right after acknowledging.
    setImmediate(() => emitLine(f, sj.aborted()))
    return { success: { still_queued: [] } }
  })
  await sendAndStart(f, 'u1')
  emitLine(f, sj.init('s'))
  emitLine(f, sj.text('working on it'))
  await until(() => h.savedKinds().includes('assistant-text'))

  const result = await stop(true)

  expect(result).toEqual({ popped: false, text: null, id: null, content: null, via: 'interrupt' })
  expect(h.fakes).toHaveLength(1)
  expect(mgr.__getGenerationForTests(TAB_OPTS.tabId)).toBe(1)
  expect(f.controlSubtypes()).toEqual(['interrupt'])
  await until(() => mgr.getSessionTerminalState(TAB_OPTS.tabId) === 'idle')
  expect(h.savedKinds().filter((k) => k === 'interrupted')).toHaveLength(1)
  expect(h.savedKinds()).not.toContain('user-message-popped')
  // The aborted turn's result never reads as an error state.
  expect(h.states).not.toContain('error')
})

test('Stop before any output: the message comes back, leaves the conversation, and the turn says nothing more', async () => {
  const h = transportHarness()
  await startTab()
  const f = h.fakes[0]
  f.answer('interrupt', () => {
    // Late output of the stopped turn, then its end (as the CLI may still write).
    setImmediate(() => {
      emitLine(f, sj.text('too late'))
      emitLine(f, sj.aborted())
    })
    return { success: { still_queued: [] } }
  })
  f.answer('rewind_conversation', (r) => ({
    success: {
      rewound: true,
      targetMessageUuid: r.target_message_uuid,
      prefillText: 'hello',
      precedingAssistantUuid: null
    }
  }))
  await sendAndStart(f, 'u1', 'hello')

  const result = await stop(true)

  // The whole message comes back (C restores attachments from `content`).
  expect(result).toEqual({
    popped: true,
    text: 'hello',
    id: 'u1',
    content: [{ type: 'text', text: 'hello' }],
    via: 'interrupt'
  })
  expect(f.controlSubtypes()).toEqual(['interrupt', 'rewind_conversation'])
  expect(f.controlRequests('rewind_conversation')[0]).toMatchObject({ target_message_uuid: 'u1' })
  expect(h.fakes).toHaveLength(1)
  await until(() => mgr.getSessionTerminalState(TAB_OPTS.tabId) === 'idle')
  await wait(30)
  expect(h.saved().find((e) => e.kind === 'user-message-popped')).toMatchObject({ id: 'u1' })
  expect(h.savedKinds()).not.toContain('interrupted')
  expect(h.broadcasts.some((b) => JSON.stringify(b.event).includes('too late'))).toBe(false)
  expect(h.savedKinds()).not.toContain('result')
  expect(mgr.__getOutboxStateForTests(TAB_OPTS.tabId, 'u1')).toBe('cancelled')
})

test('an unacknowledged interrupt falls back to a respawn; the popped message is rewound there', async () => {
  const h = transportHarness({
    onFake: (f, i) => {
      if (i === 0) f.answer('interrupt', () => 'ignore')
    }
  })
  await startTab()
  await sendAndStart(h.fakes[0], 'u1', 'hello')

  const result = await stop(true, 100)

  expect(result).toEqual({
    popped: true,
    text: 'hello',
    id: 'u1',
    content: [{ type: 'text', text: 'hello' }],
    via: 'respawn'
  })
  expect(h.fakes).toHaveLength(2)
  expect(mgr.__getGenerationForTests(TAB_OPTS.tabId)).toBe(2)
  expect(h.fakes[1].controlRequests('rewind_conversation')[0]).toMatchObject({
    target_message_uuid: 'u1'
  })
})

test('a refused interrupt falls back to a respawn', async () => {
  const h = transportHarness({
    onFake: (f, i) => {
      if (i === 0) f.answer('interrupt', () => ({ error: 'nope' }))
    }
  })
  await startTab()
  const f = h.fakes[0]
  await sendAndStart(f, 'u1')
  emitLine(f, sj.text('partial'))
  await until(() => h.savedKinds().includes('assistant-text'))

  const result = await stop(true)

  expect(result).toEqual({ popped: false, text: null, id: null, content: null, via: 'respawn' })
  expect(h.fakes).toHaveLength(2)
  expect(h.savedKinds().filter((k) => k === 'interrupted')).toHaveLength(1)
})

test('messages the CLI holds queued are withdrawn before the interrupt', async () => {
  const h = transportHarness()
  await startTab()
  const f = h.fakes[0]
  f.answer('cancel_async_message', () => ({ success: { cancelled: true } }))
  f.answer('interrupt', () => {
    setImmediate(() => emitLine(f, sj.aborted()))
    return { success: { still_queued: [] } }
  })
  await sendAndStart(f, 'u1')
  emitLine(f, sj.text('busy'))
  // A second message went straight to the CLI mid-turn: received, not started.
  mgr.dispatchUserMessage(TAB_OPTS.tabId, { id: 'u2', content: [{ type: 'text', text: 'next' }] })
  await until(() => f.stdin.some((m) => m.type === 'user' && m.uuid === 'u2'))
  emitLine(f, sj.lifecycle('u2', 'queued'))
  await wait(10)

  await stop(true)

  expect(f.controlSubtypes()).toEqual(['cancel_async_message', 'interrupt'])
  expect(f.controlRequests('cancel_async_message')[0]).toMatchObject({ message_uuid: 'u2' })
  expect(mgr.__getOutboxStateForTests(TAB_OPTS.tabId, 'u2')).toBe('cancelled')
})

test('ids the interrupt still reports queued are withdrawn too', async () => {
  const h = transportHarness()
  await startTab()
  const f = h.fakes[0]
  f.answer('cancel_async_message', () => ({ success: { cancelled: true } }))
  f.answer('interrupt', () => {
    setImmediate(() => emitLine(f, sj.aborted()))
    return { success: { still_queued: ['u2'] } }
  })
  await sendAndStart(f, 'u1')
  emitLine(f, sj.text('busy'))
  mgr.dispatchUserMessage(TAB_OPTS.tabId, { id: 'u2', content: [{ type: 'text', text: 'next' }] })
  await until(() => f.stdin.some((m) => m.type === 'user' && m.uuid === 'u2'))

  await stop(false)

  expect(f.controlSubtypes()).toEqual(['interrupt', 'cancel_async_message'])
  expect(mgr.__getOutboxStateForTests(TAB_OPTS.tabId, 'u2')).toBe('cancelled')
})

test('a popped message the CLI cannot rewind leaves a visible notice', async () => {
  const h = transportHarness()
  await startTab()
  const f = h.fakes[0]
  f.answer('interrupt', () => {
    setImmediate(() => emitLine(f, sj.aborted()))
    return { success: { still_queued: [] } }
  })
  f.answer('rewind_conversation', () => ({ error: 'internal error' }))
  await sendAndStart(f, 'u1', 'hello')

  const result = await stop(true)

  expect(result.popped).toBe(true)
  expect(h.saved().find((e) => e.kind === 'notice')).toMatchObject({ code: 'stop-rewind-failed' })
})

test('target_not_found on the rewind is fine (the CLI never stored the message)', async () => {
  const h = transportHarness()
  await startTab()
  const f = h.fakes[0]
  f.answer('interrupt', () => {
    setImmediate(() => emitLine(f, sj.aborted()))
    return { success: { still_queued: [] } }
  })
  f.answer('rewind_conversation', () => ({
    success: {
      rewound: false,
      prefillText: null,
      precedingAssistantUuid: null,
      reason: 'target_not_found'
    }
  }))
  await sendAndStart(f, 'u1', 'hello')

  await stop(true)

  expect(h.savedKinds()).not.toContain('notice')
})

test('Stop with a pending prompt: the CLI withdraws it, the gate opens, no respawn', async () => {
  const h = transportHarness()
  await startTab()
  const f = h.fakes[0]
  f.answer('interrupt', () => {
    setImmediate(() => {
      emitLine(f, sj.cancel('p1'))
      emitLine(f, sj.aborted('aborted_tools'))
      // 2.1.312 reports the interrupted message cancelled.
      emitLine(f, sj.lifecycle('u1', 'cancelled'))
    })
    return { success: { still_queued: [] } }
  })
  await sendAndStart(f, 'u1')
  emitLine(f, sj.toolUse('t1'))
  emitLine(f, sj.canUseTool('p1', 't1'))
  await until(() => mgr.isSessionAwaitingUserInput(TAB_OPTS.tabId))

  await stop(true)

  await until(() => h.savedKinds().includes('permission-cancelled'))
  await until(() => mgr.isReadyForQueuedMessage(TAB_OPTS.tabId))
  expect(h.fakes).toHaveLength(1)
})

test('the queue gate stays shut until EVERY pending prompt is answered', async () => {
  const h = transportHarness()
  await startTab()
  const f = h.fakes[0]
  await sendAndStart(f, 'u1')
  emitLine(f, sj.toolUse('t1'))
  emitLine(f, sj.toolUse('t2'))
  emitLine(f, sj.canUseTool('p1', 't1'))
  emitLine(f, sj.canUseTool('p2', 't2'))
  await until(() => h.savedKinds().filter((k) => k === 'permission-request').length === 2)

  expect(
    mgr.respondToPermissionRequest(TAB_OPTS.tabId, {
      requestId: 'p1',
      decision: { behavior: 'allow', updatedInput: {} }
    })
  ).toBe(true)
  // Tool 1 runs and reports while prompt 2 still waits.
  emitLine(f, {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    parent_tool_use_id: null
  })
  await until(() => h.savedKinds().includes('tool-result'))
  expect(mgr.isSessionAwaitingUserInput(TAB_OPTS.tabId)).toBe(true)
  expect(mgr.isReadyForQueuedMessage(TAB_OPTS.tabId)).toBe(false)
  expect(mgr.getSessionTerminalState(TAB_OPTS.tabId)).toBe('idle')

  mgr.respondToPermissionRequest(TAB_OPTS.tabId, {
    requestId: 'p2',
    decision: { behavior: 'allow', updatedInput: {} }
  })
  await until(() => !mgr.isSessionAwaitingUserInput(TAB_OPTS.tabId))
  expect(mgr.getSessionTerminalState(TAB_OPTS.tabId)).toBe('running')
  emitLine(f, sj.success())
  emitLine(f, sj.lifecycle('u1', 'completed'))
  await until(() => mgr.isReadyForQueuedMessage(TAB_OPTS.tabId))
})

test('a new process starts with no pending prompts', async () => {
  const h = transportHarness()
  await startTab()
  const f = h.fakes[0]
  await sendAndStart(f, 'u1')
  emitLine(f, sj.toolUse('t1'))
  emitLine(f, sj.canUseTool('p1', 't1'))
  await until(() => mgr.isSessionAwaitingUserInput(TAB_OPTS.tabId))
  await mgr.respawn(TAB_OPTS.tabId, { ...TAB_OPTS })
  expect(mgr.isSessionAwaitingUserInput(TAB_OPTS.tabId)).toBe(false)
})

test('no live process: Stop keeps the old path (pop, then a fresh process)', async () => {
  const h = transportHarness()
  await mgr.hydrateSession({ ...TAB_OPTS })
  const result = await stop(true)
  expect(result.via).toBe('respawn')
  expect(h.fakes).toHaveLength(1)
})

test('the queue drainer is kicked when the gate opens after the result (late completed ack)', async () => {
  const h = transportHarness()
  await startTab()
  const f = h.fakes[0]
  const kicks: string[] = []
  mgr.registerChatQueueDrainer((tabId) => {
    if (mgr.isReadyForQueuedMessage(tabId)) kicks.push(tabId)
  })
  await sendAndStart(f, 'u1')
  emitLine(f, sj.success())
  await until(() => mgr.getSessionTerminalState(TAB_OPTS.tabId) === 'idle')
  await wait(20)
  // The result came first: the message is not answered yet, the gate stays shut.
  expect(kicks).toEqual([])
  emitLine(f, sj.lifecycle('u1', 'completed'))
  await until(() => kicks.length > 0)
  mgr.registerChatQueueDrainer(() => {})
})
