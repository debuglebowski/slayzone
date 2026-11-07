/**
 * Background work of a chat tab, as clients see it — the same two signals a
 * terminal agent's hooks give (`agent-tree.ts`):
 *   - `background` state: the turn ended, a background sub-agent still runs
 *     (Claude's `Agent` with `run_in_background`, a Codex sub-agent thread);
 *   - the background-job count: `run_in_background` commands still running
 *     (the dot's jobs orbit), published on the `background-jobs` stream.
 * The turn's own state (queue gate, sends, watchdog) stays `idle`.
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

const SESSION = `${TAB_OPTS.taskId}:${TAB_OPTS.tabId}`

const agentStarted = (taskId: string, toolUseId: string) => ({
  type: 'system',
  subtype: 'task_started',
  task_id: taskId,
  tool_use_id: toolUseId,
  description: 'Research',
  task_type: 'local_agent'
})
const asyncLaunched = (toolUseId: string, agentId: string) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'launched' }] },
  parent_tool_use_id: null,
  tool_use_result: { isAsync: true, status: 'async_launched', agentId }
})
const toolResult = (toolUseId: string) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'done' }] },
  parent_tool_use_id: null
})
const taskNotification = (taskId: string, toolUseId: string, status: string) => ({
  type: 'system',
  subtype: 'task_notification',
  task_id: taskId,
  tool_use_id: toolUseId,
  status,
  summary: 'finished'
})
const commandStarted = (taskId: string, toolUseId: string, backgrounded: boolean) => ({
  type: 'system',
  subtype: 'task_started',
  task_id: taskId,
  tool_use_id: toolUseId,
  description: 'Loop',
  is_backgrounded: backgrounded,
  task_type: 'local_bash'
})
const taskUpdated = (taskId: string, patch: Record<string, unknown>) => ({
  type: 'system',
  subtype: 'task_updated',
  task_id: taskId,
  patch
})

function jobsHarness() {
  const jobs: number[] = []
  const h = transportHarness({
    deps: {
      broadcastBackgroundJobs: (sessionId, count) => {
        if (sessionId === SESSION) jobs.push(count)
      }
    }
  })
  return { h, jobs }
}

test('a background sub-agent outliving its turn reads background, then idle at its end', async () => {
  const h = transportHarness()
  await startTab()
  const f = h.fakes[0]
  await sendAndStart(f, 'u1', 'research in the background')
  emitLine(f, sj.toolUse('toolu_a', 'Agent', { prompt: 'x', run_in_background: true }))
  emitLine(f, agentStarted('a1', 'toolu_a'))
  emitLine(f, asyncLaunched('toolu_a', 'a1'))
  emitLine(f, sj.success('launched'))
  emitLine(f, sj.lifecycle('u1', 'completed'))
  await until(() => mgr.getChatSessionState(SESSION) === 'background')
  // The turn itself is over: a queued message may go.
  expect(mgr.getSessionTerminalState(TAB_OPTS.tabId)).toBe('idle')
  expect(mgr.isReadyForQueuedMessage(TAB_OPTS.tabId)).toBe(true)
  expect(mgr.listChatSessions().find((s) => s.sessionId === SESSION)?.state).toBe('background')

  emitLine(f, taskNotification('a1', 'toolu_a', 'completed'))
  await until(() => mgr.getChatSessionState(SESSION) === 'idle')
  expect(h.states).toEqual(['starting', 'idle', 'running', 'background', 'idle'])
})

test('a foreground sub-agent ends with its tool result: no background state', async () => {
  const h = transportHarness()
  await startTab()
  const f = h.fakes[0]
  await sendAndStart(f, 'u1')
  emitLine(f, sj.toolUse('toolu_f', 'Agent', { prompt: 'x' }))
  emitLine(f, agentStarted('a2', 'toolu_f'))
  emitLine(f, toolResult('toolu_f'))
  emitLine(f, sj.success('done'))
  await until(() => mgr.getSessionTerminalState(TAB_OPTS.tabId) === 'idle')
  await wait(10)
  expect(mgr.getChatSessionState(SESSION)).toBe('idle')
  expect(h.states).not.toContain('background')
})

test('a prompt waiting while a background sub-agent runs reads idle (needs you)', async () => {
  const h = transportHarness()
  await startTab()
  const f = h.fakes[0]
  await sendAndStart(f, 'u1')
  emitLine(f, sj.toolUse('toolu_a', 'Agent', { prompt: 'x', run_in_background: true }))
  emitLine(f, agentStarted('a1', 'toolu_a'))
  emitLine(f, asyncLaunched('toolu_a', 'a1'))
  emitLine(f, sj.canUseTool('r1', 'tu1'))
  await until(() => mgr.isSessionAwaitingUserInput(TAB_OPTS.tabId))
  expect(mgr.getChatSessionState(SESSION)).toBe('idle')
  expect(h.states).not.toContain('background')
})

test('the process ending drops its background sub-agents', async () => {
  const h = transportHarness()
  await startTab()
  const f = h.fakes[0]
  await sendAndStart(f, 'u1')
  emitLine(f, sj.toolUse('toolu_a', 'Agent', { prompt: 'x', run_in_background: true }))
  emitLine(f, agentStarted('a1', 'toolu_a'))
  emitLine(f, asyncLaunched('toolu_a', 'a1'))
  emitLine(f, sj.success('launched'))
  await until(() => mgr.getChatSessionState(SESSION) === 'background')
  f.exit(1)
  await until(() => h.states[h.states.length - 1] === 'dead')
  expect(h.states.slice(-2)).toEqual(['background', 'dead'])
})

test('a running background command is counted as a job until it ends', async () => {
  const { h, jobs } = jobsHarness()
  await startTab()
  const f = h.fakes[0]
  await sendAndStart(f, 'u1', 'loop in the background')
  emitLine(f, sj.toolUse('toolu_b', 'Bash', { command: 'loop', run_in_background: true }))
  emitLine(f, commandStarted('t1', 'toolu_b', true))
  emitLine(f, sj.success('STARTED'))
  await until(() => jobs[jobs.length - 1] === 1)
  // Jobs alone are the orbit, not a state (terminal-mode parity).
  expect(mgr.getChatSessionState(SESSION)).toBe('idle')
  expect(mgr.listChatSessions().find((s) => s.sessionId === SESSION)?.backgroundJobs).toBe(1)

  emitLine(f, taskUpdated('t1', { status: 'completed', end_time: 1 }))
  await until(() => jobs[jobs.length - 1] === 0)
  expect(jobs).toEqual([1, 0])
  expect(mgr.listChatSessions().find((s) => s.sessionId === SESSION)?.backgroundJobs).toBe(
    undefined
  )
})

test('a foreground command moved to the background becomes a job', async () => {
  const { h, jobs } = jobsHarness()
  await startTab()
  const f = h.fakes[0]
  await sendAndStart(f, 'u1')
  emitLine(f, sj.toolUse('toolu_c', 'Bash', { command: 'serve' }))
  emitLine(f, commandStarted('t2', 'toolu_c', false))
  await wait(10)
  expect(jobs).toEqual([])
  emitLine(f, taskUpdated('t2', { is_backgrounded: true }))
  await until(() => jobs[jobs.length - 1] === 1)
  f.exit(0)
  await until(() => jobs[jobs.length - 1] === 0)
  expect(jobs).toEqual([1, 0])
})
