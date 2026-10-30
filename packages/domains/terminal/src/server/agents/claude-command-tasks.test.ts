/**
 * ClaudeCommandTasks: one Claude process's `system/task_*` frames → command
 * tasks (Bash / Monitor) or the unchanged `sub-agent` event, plus the task
 * control requests (get_task_output, stop_task, background_tasks).
 * Wire shapes: CLI spike item 14 (Claude Code 2.1.312).
 */
import { describe, expect, it } from 'vitest'
import type { AgentEvent, CliTaskEvent } from '@slayzone/terminal-contracts'
import { ClaudeCommandTasks } from './claude-command-tasks'

interface Pending {
  request: Record<string, unknown>
  resolve: (data: unknown) => void
  reject: (err: Error) => void
}

function harness() {
  let now = 1_000
  const emitted: AgentEvent[] = []
  const requests: Pending[] = []
  const tasks = new ClaudeCommandTasks({
    request: (request) =>
      new Promise((resolve, reject) => {
        requests.push({ request, resolve, reject })
      }),
    emit: (ev) => emitted.push(ev),
    now: () => now
  })
  return {
    tasks,
    emitted,
    requests,
    advance: (ms: number) => {
      now += ms
    },
    get now() {
      return now
    }
  }
}

const started = (over: Partial<CliTaskEvent> = {}): CliTaskEvent => ({
  kind: 'cli-task',
  subtype: 'started',
  taskId: 't1',
  toolUseId: 'toolu_1',
  taskType: 'local_bash',
  description: 'Ticks',
  backgrounded: false,
  raw: {},
  ...over
})
const updated = (over: Partial<CliTaskEvent>): CliTaskEvent => ({
  kind: 'cli-task',
  subtype: 'updated',
  taskId: 't1',
  raw: {},
  ...over
})
const notification = (over: Partial<CliTaskEvent>): CliTaskEvent => ({
  kind: 'cli-task',
  subtype: 'notification',
  taskId: 't1',
  toolUseId: 'toolu_1',
  status: 'completed',
  raw: {},
  ...over
})
/** The CLI's control_response payload as the driver resolves it. */
const reply = (output: string, extra: Record<string, unknown> = {}) => ({
  response: { output, total_bytes: Buffer.byteLength(output), truncated: false, ...extra }
})
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('ClaudeCommandTasks — routing task frames', () => {
  it('a local_bash task is a command task: full snapshot, started when its call was seen', () => {
    const h = harness()
    h.tasks.noteToolCall('toolu_1')
    h.advance(3_000)
    expect(h.tasks.route(started())).toEqual({
      kind: 'command-task',
      taskId: 't1',
      toolUseId: 'toolu_1',
      status: 'running',
      backgrounded: false,
      description: 'Ticks',
      startedAt: 1_000
    })
  })

  it('an approval after the call moves the start to the approval', () => {
    const h = harness()
    h.tasks.noteToolCall('toolu_1')
    h.advance(5_000)
    h.tasks.noteToolApproved('toolu_1')
    h.advance(3_000)
    expect(h.tasks.route(started())).toMatchObject({ startedAt: 6_000 })
  })

  it('without a seen call, the task starts when the CLI reports it', () => {
    const h = harness()
    expect(h.tasks.route(started())).toMatchObject({ startedAt: 1_000 })
  })

  it('a local_agent task keeps today’s sub-agent event, field for field', () => {
    const h = harness()
    const raw = { type: 'system', subtype: 'task_started', task_id: 'a1' }
    const ev = h.tasks.route(
      started({
        taskId: 'a1',
        toolUseId: 'tu_42',
        taskType: 'local_agent',
        description: 'Find chat history parsing logic',
        parentToolUseId: 'tu_parent',
        raw
      })
    )
    expect(ev).toEqual({
      kind: 'sub-agent',
      phase: 'in-flight',
      toolUseId: 'tu_42',
      parentToolUseId: 'tu_parent',
      description: 'Find chat history parsing logic',
      status: undefined,
      summary: undefined,
      usage: undefined,
      raw
    })
  })

  it('a task without task_type (older CLI) stays a sub-agent', () => {
    const h = harness()
    expect(h.tasks.route(started({ taskType: undefined }))).toMatchObject({ kind: 'sub-agent' })
  })

  it('task_updated of a sub-agent is dropped (it used to append a toolUseId:"" row)', () => {
    const h = harness()
    h.tasks.route(started({ taskId: 'a1', taskType: 'local_agent', toolUseId: 'tu_42' }))
    expect(h.tasks.route(updated({ taskId: 'a1', status: 'completed', endTime: 5 }))).toBe(null)
    expect(h.tasks.route(updated({ taskId: 'nobody', status: 'completed' }))).toBe(null)
  })

  it('a sub-agent notification keeps status, summary and usage', () => {
    const h = harness()
    h.tasks.route(started({ taskId: 'a1', taskType: 'local_agent', toolUseId: 'tu_42' }))
    const usage = { totalTokens: 63119, toolUses: 23, durationMs: 52641 }
    expect(
      h.tasks.route(notification({ taskId: 'a1', toolUseId: 'tu_42', summary: 'Done', usage }))
    ).toMatchObject({
      kind: 'sub-agent',
      phase: 'in-flight',
      toolUseId: 'tu_42',
      status: 'completed',
      summary: 'Done',
      usage
    })
  })

  it('a notification for a task never seen started, with a tool id, stays a sub-agent', () => {
    const h = harness()
    expect(h.tasks.route(notification({ taskId: 'x', toolUseId: 'tu_x' }))).toMatchObject({
      kind: 'sub-agent',
      toolUseId: 'tu_x'
    })
    expect(h.tasks.route(notification({ taskId: 'y', toolUseId: undefined }))).toBe(null)
  })

  it('updates resolve the tool id by task id: moved to background, killed', () => {
    const h = harness()
    h.tasks.route(started())
    expect(h.tasks.route(updated({ backgrounded: true }))).toMatchObject({
      kind: 'command-task',
      toolUseId: 'toolu_1',
      status: 'running',
      backgrounded: true
    })
    expect(h.tasks.route(updated({ status: 'killed', endTime: 9_999 }))).toMatchObject({
      status: 'killed',
      backgrounded: true,
      endedAt: 9_999
    })
  })

  it('notification statuses: completed, failed, stopped → killed; ends at "now" without end_time', () => {
    for (const [cli, ours] of [
      ['completed', 'completed'],
      ['failed', 'failed'],
      ['stopped', 'killed']
    ] as const) {
      const h = harness()
      h.tasks.route(started())
      h.advance(500)
      expect(h.tasks.route(notification({ status: cli }))).toMatchObject({
        kind: 'command-task',
        status: ours,
        endedAt: 1_500
      })
    }
  })

  it('a notification after an update keeps the earlier end time', () => {
    const h = harness()
    h.tasks.route(started({ backgrounded: true }))
    h.tasks.route(updated({ status: 'completed', endTime: 4_242 }))
    h.advance(10)
    expect(h.tasks.route(notification({}))).toMatchObject({ endedAt: 4_242 })
  })
})

describe('ClaudeCommandTasks — final output of a background command', () => {
  it('once a background command ended, its output is read once and saved', async () => {
    const h = harness()
    h.tasks.route(started({ backgrounded: true }))
    h.tasks.route(updated({ status: 'completed', endTime: 2_000 }))
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0].request).toEqual({ subtype: 'get_task_output', task_id: 't1' })
    // The notification right after does not read it again.
    h.tasks.route(notification({}))
    expect(h.requests).toHaveLength(1)
    h.requests[0].resolve(reply('tick 1\n\n[exited with code 0]\n'))
    await flush()
    expect(h.emitted).toEqual([
      {
        kind: 'command-task-output',
        taskId: 't1',
        toolUseId: 'toolu_1',
        output: 'tick 1\n\n[exited with code 0]\n',
        totalBytes: 29,
        truncated: false
      }
    ])
  })

  it('a foreground command’s output is its tool result: nothing is read', () => {
    const h = harness()
    h.tasks.route(started())
    h.tasks.route(notification({}))
    expect(h.requests).toHaveLength(0)
  })

  it('a stopped background command saves its output too', async () => {
    const h = harness()
    h.tasks.route(started({ backgrounded: true }))
    h.tasks.route(updated({ status: 'killed' }))
    h.requests[0].resolve(reply('tick 1\n\n[killed]\n'))
    await flush()
    expect(h.emitted[0]).toMatchObject({
      kind: 'command-task-output',
      output: 'tick 1\n\n[killed]\n'
    })
  })

  it('nothing is emitted once the process is gone (dispose)', async () => {
    const h = harness()
    h.tasks.route(started({ backgrounded: true }))
    h.tasks.route(notification({}))
    h.tasks.dispose()
    h.requests[0].resolve(reply('late'))
    await flush()
    expect(h.emitted).toEqual([])
  })

  it('a failed read saves nothing (no error event)', async () => {
    const h = harness()
    h.tasks.route(started({ backgrounded: true }))
    h.tasks.route(notification({}))
    h.requests[0].reject(new Error('control_request timeout after 5000ms'))
    await flush()
    expect(h.emitted).toEqual([])
  })
})

describe('ClaudeCommandTasks — polling output', () => {
  it('an unknown task is gone (its process was replaced, or it never was a command)', async () => {
    const h = harness()
    expect(await h.tasks.output('nope')).toEqual({ state: 'gone' })
    h.tasks.route(started({ taskId: 'a1', taskType: 'local_agent' }))
    expect(await h.tasks.output('a1')).toEqual({ state: 'gone' })
    expect(h.requests).toHaveLength(0)
  })

  it('a running command: asks the CLI, normalizes the reply', async () => {
    const h = harness()
    h.tasks.route(started())
    const p = h.tasks.output('t1')
    expect(h.requests.map((r) => r.request)).toEqual([
      { subtype: 'get_task_output', task_id: 't1' }
    ])
    h.requests[0].resolve(reply('x'.repeat(8192), { total_bytes: 10_000, truncated: true }))
    expect(await p).toEqual({
      state: 'running',
      output: 'x'.repeat(8192),
      totalBytes: 10_000,
      truncated: true
    })
  })

  it('concurrent polls share one request; a poll within 500 ms is answered from it', async () => {
    const h = harness()
    h.tasks.route(started())
    const a = h.tasks.output('t1')
    const b = h.tasks.output('t1')
    expect(h.requests).toHaveLength(1)
    h.requests[0].resolve(reply('tick 1\n'))
    expect(await a).toEqual(await b)
    h.advance(400)
    expect(await h.tasks.output('t1')).toMatchObject({ output: 'tick 1\n' })
    expect(h.requests).toHaveLength(1)
    h.advance(200)
    void h.tasks.output('t1')
    expect(h.requests).toHaveLength(2)
  })

  it('a finished foreground command reports ended without asking (its output is gone)', async () => {
    const h = harness()
    h.tasks.route(started())
    h.tasks.route(notification({}))
    expect(await h.tasks.output('t1')).toEqual({
      state: 'ended',
      output: '',
      totalBytes: 0,
      truncated: false
    })
    expect(h.requests).toHaveLength(0)
  })

  it('a finished background command reports ended with the output the CLI kept', async () => {
    const h = harness()
    h.tasks.route(started({ backgrounded: true }))
    h.tasks.route(notification({}))
    h.requests[0].resolve(reply('done\n'))
    await flush()
    h.advance(1_000)
    const p = h.tasks.output('t1')
    h.requests[1].resolve(reply('done\n'))
    expect(await p).toMatchObject({ state: 'ended', output: 'done\n' })
  })

  it('the CLI refusing the task id → gone', async () => {
    const h = harness()
    h.tasks.route(started())
    const p = h.tasks.output('t1')
    h.requests[0].reject(
      new Error('get_task_output: no shell or Monitor task with that task_id in this session')
    )
    expect(await p).toEqual({ state: 'gone' })
  })

  it('a timeout keeps the last known output; with none it rejects', async () => {
    const h = harness()
    h.tasks.route(started())
    const first = h.tasks.output('t1')
    h.requests[0].resolve(reply('tick 1\n'))
    await first
    h.advance(1_000)
    const second = h.tasks.output('t1')
    h.requests[1].reject(new Error('control_request timeout after 5000ms'))
    expect(await second).toMatchObject({ state: 'running', output: 'tick 1\n' })

    const h2 = harness()
    h2.tasks.route(started())
    const lone = h2.tasks.output('t1')
    h2.requests[0].reject(new Error('control_request timeout after 5000ms'))
    await expect(lone).rejects.toThrow('timeout')
  })

  it('after dispose every task is gone', async () => {
    const h = harness()
    h.tasks.route(started())
    h.tasks.dispose()
    expect(await h.tasks.output('t1')).toEqual({ state: 'gone' })
  })
})

describe('ClaudeCommandTasks — stop and move to background', () => {
  it('stop sends stop_task for a running command', async () => {
    const h = harness()
    h.tasks.route(started({ backgrounded: true }))
    const p = h.tasks.stop('t1')
    expect(h.requests.map((r) => r.request)).toEqual([{ subtype: 'stop_task', task_id: 't1' }])
    h.requests[0].resolve({ response: {} })
    await p
  })

  it('stop refuses an unknown or finished task', async () => {
    const h = harness()
    await expect(h.tasks.stop('nope')).rejects.toThrow(/not running/)
    h.tasks.route(started())
    h.tasks.route(notification({}))
    await expect(h.tasks.stop('t1')).rejects.toThrow(/not running/)
    expect(h.requests).toHaveLength(0)
  })

  it('background sends background_tasks for a running foreground command', async () => {
    const h = harness()
    h.tasks.route(started())
    const p = h.tasks.background('toolu_1')
    expect(h.requests.map((r) => r.request)).toEqual([
      { subtype: 'background_tasks', tool_use_id: 'toolu_1' }
    ])
    h.requests[0].resolve({ response: { backgrounded: true } })
    expect(await p).toBe(true)
  })

  it('background: false for a command that is not a running foreground one', async () => {
    const h = harness()
    expect(await h.tasks.background('toolu_1')).toBe(false)
    h.tasks.route(started({ backgrounded: true }))
    expect(await h.tasks.background('toolu_1')).toBe(false)
    expect(h.requests).toHaveLength(0)
  })
})
