/**
 * A turn the agent starts on its own: Claude Code answers a finished background
 * task (`task_notification`) with a new turn — init, output, result — and no user
 * message opens it. The tab must read `running` for that turn (its spinner), and
 * go back to `idle` at its end; queued messages wait for it.
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

afterEach(() => {
  mgr.__resetForTests()
  mgr.resetTransportDeps()
})

const streamStart = {
  type: 'stream_event',
  event: { type: 'message_start', message: { id: 'msg_b' } },
  parent_tool_use_id: null
}

async function finishFirstTurn(f: Parameters<typeof sendAndStart>[0]): Promise<void> {
  await sendAndStart(f, 'u1', 'run it in the background')
  emitLine(f, sj.text('STARTED', { id: 'msg_a' }))
  emitLine(f, sj.success('STARTED'))
  emitLine(f, sj.lifecycle('u1', 'completed'))
  await until(() => mgr.getSessionTerminalState(TAB_OPTS.tabId) === 'idle')
}

test('the agent opening a turn by itself reads running until its result', async () => {
  const h = transportHarness()
  await startTab()
  const f = h.fakes[0]
  await finishFirstTurn(f)
  h.states.length = 0

  // The background task ended: the CLI starts a turn on its own.
  emitLine(f, sj.init('sess'))
  await wait(10)
  // Session metadata alone is not a turn (Codex sends one at handshake).
  expect(mgr.getSessionTerminalState(TAB_OPTS.tabId)).toBe('idle')
  emitLine(f, streamStart)
  await until(() => mgr.getSessionTerminalState(TAB_OPTS.tabId) === 'running')
  expect(mgr.isReadyForQueuedMessage(TAB_OPTS.tabId)).toBe(false)

  emitLine(f, sj.text('The background countdown finished', { id: 'msg_b' }))
  emitLine(f, sj.success('done'))
  await until(() => mgr.getSessionTerminalState(TAB_OPTS.tabId) === 'idle')
  expect(h.states).toEqual(['running', 'idle'])
  expect(mgr.isReadyForQueuedMessage(TAB_OPTS.tabId)).toBe(true)
})

test("a background sub-agent's output does not open a main turn", async () => {
  const h = transportHarness()
  await startTab()
  const f = h.fakes[0]
  await finishFirstTurn(f)
  emitLine(f, { ...sj.text('sub-agent at work', { id: 'msg_s' }), parent_tool_use_id: 'toolu_bg' })
  await wait(20)
  expect(mgr.getSessionTerminalState(TAB_OPTS.tabId)).toBe('idle')
})

test('output while a prompt waits does not reopen the turn', async () => {
  const h = transportHarness()
  await startTab()
  const f = h.fakes[0]
  await sendAndStart(f, 'u1')
  emitLine(f, sj.canUseTool('r1', 'tu1'))
  await until(() => mgr.isSessionAwaitingUserInput(TAB_OPTS.tabId))
  expect(mgr.getSessionTerminalState(TAB_OPTS.tabId)).toBe('idle')
  emitLine(f, sj.text('still thinking about it', { id: 'msg_p' }))
  await wait(20)
  expect(mgr.getSessionTerminalState(TAB_OPTS.tabId)).toBe('idle')
})

test('"No" on a prompt of a self-started turn ends it at its interrupted marker', async () => {
  const h = transportHarness()
  await startTab()
  const f = h.fakes[0]
  await finishFirstTurn(f)

  // The CLI starts a turn by itself and parks it on a prompt.
  emitLine(f, sj.init('sess'))
  emitLine(f, streamStart)
  emitLine(f, sj.toolUse('tu_w', 'Write'))
  emitLine(f, sj.canUseTool('r_w', 'tu_w'))
  await until(() => mgr.isSessionAwaitingUserInput(TAB_OPTS.tabId))
  expect(mgr.isTurnOpen(TAB_OPTS.tabId)).toBe(true)

  // The answer and the `interrupted` marker after it: the turn ends at the
  // marker, for the runtime and the lifecycle model alike (the strict check).
  mgr.respondToPermissionRequest(TAB_OPTS.tabId, {
    requestId: 'r_w',
    decision: { behavior: 'deny', message: 'no', interrupt: true }
  })
  await until(() => mgr.isReadyForQueuedMessage(TAB_OPTS.tabId))
  expect(mgr.isSessionAwaitingUserInput(TAB_OPTS.tabId)).toBe(false)
  expect(mgr.isTurnOpen(TAB_OPTS.tabId)).toBe(false)

  // The CLI's own end of the aborted turn changes nothing.
  emitLine(f, sj.aborted('aborted_tools'))
  await mgr.__flushEventsForTests(TAB_OPTS.tabId)
  expect(mgr.isTurnOpen(TAB_OPTS.tabId)).toBe(false)
  expect(mgr.getSessionTerminalState(TAB_OPTS.tabId)).toBe('idle')
})
