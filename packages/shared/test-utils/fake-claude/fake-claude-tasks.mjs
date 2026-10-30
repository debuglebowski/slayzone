// Command tasks for fake-claude.mjs (plan item 3.9): a Bash / Monitor command the
// CLI runs as a task, played the way Claude Code 2.1.312 does it (spike item 14,
// transcripts 14-foreground / 14-run-in-background / 14-background-mid-run /
// 14-stop-task). Spec type + builder: tasks.ts. Self-contained: fake-claude.mjs
// only hands it its output primitives and routes the `task` step + three control
// requests here.
//
// Verified behaviour mirrored here:
//   - foreground: `task_started` (is_backgrounded:false) a few seconds in; output
//     grows; on exit `task_notification completed` then the tool_result with the
//     whole output; afterwards `get_task_output` answers empty (output dropped).
//   - run_in_background: `background_tasks_changed` + `task_started`
//     (is_backgrounded:true) at once, tool_result "Command running in background
//     with ID: …"; on exit `task_updated {status:'completed'}` +
//     `task_notification` + `background_tasks_changed`; the output (with
//     "[exited with code N]") stays readable.
//   - `background_tasks {tool_use_id}` on a running foreground command:
//     `background_tasks_changed` + `task_updated {patch:{is_backgrounded:true}}`,
//     ack `{backgrounded:true}`, tool_result "Command was manually backgrounded…".
//   - `stop_task {task_id}`: `task_updated {status:'killed'}` +
//     `task_notification stopped` + `background_tasks_changed`, ack `{}`, output
//     ends with "[killed]".
//   - `get_task_output {task_id}`: `{output (last 8 KiB), total_bytes, truncated}`;
//     an unknown id is an error reply.
// NOT verified on the real CLI: `stop_task` on a FOREGROUND command (played as a
// killed command whose tool_result is an error).

import { randomUUID } from 'node:crypto'

/** `get_task_output` returns the last 8 KiB of the output. */
const OUTPUT_WINDOW_BYTES = 8192

/**
 * @param {{
 *   emit: (event: object) => Promise<void>,
 *   writeLine: (event: object) => Promise<void>,
 *   sleep: (ms: number, signal: AbortSignal | null) => Promise<void>,
 *   log: (kind: string, data: object) => void,
 *   runSteps: (steps: object[] | undefined, signal: AbortSignal | null) => Promise<void>,
 *   Aborted: new () => Error
 * }} io
 */
export function createTaskSim(io) {
  /** taskId → task state. */
  const tasks = new Map()

  const runId = () => `run-${randomUUID().slice(0, 8)}`
  const outputFile = (t) => `/tmp/fake-claude/{{sessionId}}/tasks/${t.spec.taskId}.output`
  const system = (subtype, fields) => ({
    type: 'system',
    subtype,
    ...fields,
    uuid: randomUUID(),
    session_id: '{{sessionId}}'
  })
  const taskType = (t) => t.spec.taskType ?? 'local_bash'

  function backgroundList() {
    const list = [...tasks.values()]
      .filter((t) => t.status === 'running' && t.backgrounded)
      .map((t) => ({
        task_id: t.spec.taskId,
        run_id: t.runId,
        task_type: taskType(t),
        description: t.spec.description ?? ''
      }))
    return io.emit(system('background_tasks_changed', { tasks: list }))
  }

  function toolResult(t, content, isError) {
    return io.emit({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            tool_use_id: t.spec.toolUseId,
            type: 'tool_result',
            content,
            is_error: Boolean(isError)
          }
        ]
      },
      parent_tool_use_id: null,
      session_id: '{{sessionId}}',
      uuid: randomUUID()
    })
  }

  function started(t) {
    return io.emit(
      system('task_started', {
        task_id: t.spec.taskId,
        run_id: t.runId,
        tool_use_id: t.spec.toolUseId,
        description: t.spec.description ?? '',
        is_backgrounded: t.backgrounded,
        task_type: taskType(t)
      })
    )
  }

  function notification(t, status) {
    return io.emit(
      system('task_notification', {
        task_id: t.spec.taskId,
        run_id: t.runId,
        tool_use_id: t.spec.toolUseId,
        status,
        output_file: t.backgrounded ? outputFile(t) : '',
        summary: t.spec.description ?? ''
      })
    )
  }

  function updated(t, patch) {
    return io.emit(system('task_updated', { task_id: t.spec.taskId, run_id: t.runId, patch }))
  }

  /** A background command exited on its own. */
  async function finishBackground(t) {
    if (t.status !== 'running') return
    t.status = 'completed'
    t.output += `\n[exited with code ${t.spec.exitCode ?? 0}]\n`
    io.log('task-exit', { taskId: t.spec.taskId, background: true })
    await updated(t, { status: 'completed', end_time: Date.now() })
    await notification(t, 'completed')
    await backgroundList()
    if (t.spec.afterBackgroundExit) await io.runSteps(t.spec.afterBackgroundExit, null)
  }

  /** Run the `task` step. Returns when the turn may go on (exit, or backgrounded). */
  async function run(spec, signal) {
    const t = {
      spec,
      runId: runId(),
      output: '',
      status: 'pending',
      backgrounded: Boolean(spec.background),
      timers: [],
      /** Resolves the foreground wait: 'exited' | 'backgrounded' | 'killed'. */
      settle: null
    }
    tasks.set(spec.taskId, t)
    const chunksEnd = spec.output.reduce((m, c) => Math.max(m, c.atMs), 0)
    const endAt = spec.endAtMs ?? chunksEnd + 100
    for (const chunk of spec.output) {
      t.timers.push(
        setTimeout(() => {
          if (t.status === 'pending' || t.status === 'running') t.output += chunk.text
        }, chunk.atMs)
      )
    }
    const exited = new Promise((resolve) => {
      t.timers.push(setTimeout(() => resolve('exited'), endAt))
    })

    if (t.backgrounded) {
      t.status = 'running'
      await backgroundList()
      await started(t)
      await toolResult(
        t,
        `Command running in background with ID: ${spec.taskId}. Output is being written to: ${outputFile(t)}`
      )
      void exited.then(() => finishBackground(t))
      return
    }

    // Foreground: the CLI reports the task only after a few seconds; a command
    // that is done by then never becomes a task.
    const first = await Promise.race([
      io.sleep(spec.startAfterMs ?? 300, signal).then(() => 'start'),
      exited
    ])
    if (first === 'exited') {
      t.status = 'completed'
      tasks.delete(spec.taskId)
      await toolResult(t, t.output.replace(/\n$/, ''), (spec.exitCode ?? 0) !== 0)
      return
    }
    t.status = 'running'
    await started(t)
    const outcome = await new Promise((resolve, reject) => {
      t.settle = resolve
      void exited.then(() => resolve('exited'))
      signal?.addEventListener('abort', () => {
        // Interrupted: the command dies with the turn (the turn's interrupt
        // reaction rejects the open tool_use).
        t.status = 'killed'
        for (const timer of t.timers) clearTimeout(timer)
        reject(new io.Aborted())
      })
    })
    t.settle = null
    if (outcome === 'backgrounded') {
      await toolResult(
        t,
        `Command was manually backgrounded by user with ID: ${spec.taskId}. Output is being written to: ${outputFile(t)}`
      )
      void exited.then(() => finishBackground(t))
      return
    }
    if (outcome === 'killed') {
      await toolResult(t, `${t.output}[killed]`, true)
      return
    }
    t.status = 'completed'
    io.log('task-exit', { taskId: spec.taskId, background: false })
    await notification(t, 'completed')
    const full = t.output.replace(/\n$/, '')
    const code = spec.exitCode ?? 0
    await toolResult(t, code === 0 ? full : `Exit code ${code}\n${full}`, code !== 0)
    // A finished foreground command's output is dropped (empty answers after).
    t.output = ''
  }

  function reply(msg, payload) {
    return io.writeLine({
      type: 'control_response',
      response: { subtype: 'success', request_id: msg.request_id, response: payload }
    })
  }

  function refuse(msg, error) {
    return io.writeLine({
      type: 'control_response',
      response: { subtype: 'error', request_id: msg.request_id, error }
    })
  }

  /** Answer a task control request; false when `msg` is not one. */
  async function onControl(msg) {
    const req = msg.request ?? {}
    if (req.subtype === 'get_task_output') {
      const t = tasks.get(req.task_id)
      if (!t) {
        await refuse(
          msg,
          'get_task_output: no shell or Monitor task with that task_id in this session'
        )
        return true
      }
      const bytes = Buffer.from(t.output, 'utf8')
      const truncated = bytes.length > OUTPUT_WINDOW_BYTES
      const output = truncated
        ? bytes.subarray(bytes.length - OUTPUT_WINDOW_BYTES).toString('utf8')
        : t.output
      io.log('task-poll', { taskId: req.task_id, totalBytes: bytes.length })
      await reply(msg, { output, total_bytes: bytes.length, truncated })
      return true
    }
    if (req.subtype === 'stop_task') {
      const t = tasks.get(req.task_id)
      if (!t || t.status !== 'running') {
        await refuse(msg, `stop_task: no running task with id ${req.task_id}`)
        return true
      }
      t.status = 'killed'
      for (const timer of t.timers) clearTimeout(timer)
      t.output += '\n[killed]\n'
      io.log('task-stop', { taskId: req.task_id })
      await updated(t, { status: 'killed', end_time: Date.now() })
      await notification(t, 'stopped')
      await backgroundList()
      await reply(msg, {})
      t.settle?.('killed')
      return true
    }
    if (req.subtype === 'background_tasks') {
      const t = [...tasks.values()].find(
        (x) => x.spec.toolUseId === req.tool_use_id && x.status === 'running' && !x.backgrounded
      )
      if (!t) {
        await reply(msg, { backgrounded: false })
        return true
      }
      t.backgrounded = true
      io.log('task-background', { taskId: t.spec.taskId })
      await backgroundList()
      await updated(t, { is_backgrounded: true })
      await reply(msg, { backgrounded: true })
      t.settle?.('backgrounded')
      return true
    }
    return false
  }

  return { run, onControl }
}
