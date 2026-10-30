/**
 * Command tasks of ONE Claude Code process (plan item 3.9).
 *
 * The CLI runs a Bash (or Monitor) call as a "task" and reports it with
 * `system/task_*` frames — the same frames it uses for sub-agents. Only
 * `task_started` names the `task_type`, and `task_updated` carries no
 * `tool_use_id`, so the stateless adapter emits neutral `cli-task` events and
 * this per-process tracker resolves each by `taskId`:
 *   - `local_bash` → `command-task` (a full snapshot of the task, saved);
 *   - anything else (sub-agents, older CLIs without `task_type`) → the
 *     `sub-agent` event exactly as before; their `task_updated` is dropped
 *     (it used to append a row with an empty tool id).
 *
 * It also owns the task control requests (CLI spike item 14):
 *   - `get_task_output {task_id}` → the last 8 KiB of a running command's output
 *     (polled by the chat while the command card is on screen; concurrent polls
 *     share one request, a poll within {@link OUTPUT_CACHE_MS} reuses it);
 *   - once a BACKGROUND command ended, its output is read once and saved as
 *     `command-task-output` (a foreground command's output is its tool result);
 *   - `stop_task {task_id}` and `background_tasks {tool_use_id}`.
 *
 * Lives and dies with its process (owned by the session driver), so a replaced
 * process's tasks are simply unknown to the next one.
 *
 * @module agents/claude-command-tasks
 */
import type {
  AgentEvent,
  CliTaskEvent,
  CommandTaskEvent,
  CommandTaskOutput,
  CommandTaskStatus
} from '@slayzone/terminal-contracts'

/** The CLI answers `get_task_output` in 1–19 ms; anything near this is a stuck process. */
const TASK_REQUEST_TIMEOUT_MS = 5_000
/** A poll this soon after the last answer gets that answer (many viewers ≈ one CLI request). */
export const OUTPUT_CACHE_MS = 500

export interface CommandTaskIo {
  /** Send a control_request; resolves with the CLI's reply (`{response: payload}`). */
  request(request: Record<string, unknown>, timeoutMs: number): Promise<unknown>
  /** Route an event through the transport (only while the process lives). */
  emit(event: AgentEvent): void
  now(): number
}

interface CommandTask {
  snapshot: CommandTaskEvent
  /** The final output has been requested (background commands, once). */
  finalRead: boolean
}

type Output = Extract<CommandTaskOutput, { output: string }>

export class ClaudeCommandTasks {
  private readonly commands = new Map<string, CommandTask>()
  /** tool_use_id → when the call was seen / approved (host clock). */
  private readonly callStarts = new Map<string, number>()
  private readonly inflight = new Map<string, Promise<CommandTaskOutput>>()
  private readonly lastOutput = new Map<string, { at: number; value: Output }>()
  private disposed = false

  constructor(private readonly io: CommandTaskIo) {}

  /** The agent called a tool: a command it runs starts about now. */
  noteToolCall(toolUseId: string): void {
    this.callStarts.set(toolUseId, this.io.now())
  }

  /** The user approved a tool call: the command starts now, not at the call. */
  noteToolApproved(toolUseId: string): void {
    if (this.callStarts.has(toolUseId)) this.callStarts.set(toolUseId, this.io.now())
  }

  /** One `cli-task` frame → the event to emit, or null to drop it. */
  route(ev: CliTaskEvent): AgentEvent | null {
    if (ev.subtype === 'started') {
      if (ev.taskType === 'local_bash' && ev.toolUseId) return this.startCommand(ev, ev.toolUseId)
      return subAgent(ev)
    }
    const command = this.commands.get(ev.taskId)
    if (!command) {
      // A sub-agent (or a task of another process): its notification carries the
      // stats the sub-agent row shows; its update carries nothing it uses.
      return ev.subtype === 'notification' && ev.toolUseId ? subAgent(ev) : null
    }
    const prev = command.snapshot
    const status = ev.status ? (commandStatus(ev.status) ?? prev.status) : prev.status
    const ended = status !== 'running'
    const next: CommandTaskEvent = {
      ...prev,
      status,
      backgrounded: ev.backgrounded ?? prev.backgrounded,
      ...(ended ? { endedAt: prev.endedAt ?? ev.endTime ?? this.io.now() } : {})
    }
    command.snapshot = next
    if (ended && next.backgrounded && !command.finalRead) {
      command.finalRead = true
      void this.readFinalOutput(next)
    }
    return next
  }

  /** The command's output so far (polled while its card is on screen). */
  output(taskId: string): Promise<CommandTaskOutput> {
    const command = this.disposed ? undefined : this.commands.get(taskId)
    if (!command) return Promise.resolve({ state: 'gone' })
    const { snapshot } = command
    if (snapshot.status !== 'running' && !snapshot.backgrounded) {
      // The CLI drops a finished foreground command's output: it is the tool result.
      return Promise.resolve({ state: 'ended', output: '', totalBytes: 0, truncated: false })
    }
    const state = snapshot.status === 'running' ? 'running' : 'ended'
    const cached = this.lastOutput.get(taskId)
    if (cached && this.io.now() - cached.at < OUTPUT_CACHE_MS) {
      return Promise.resolve({ ...cached.value, state })
    }
    const pending = this.inflight.get(taskId)
    if (pending) return pending
    const request = this.readOutput(taskId)
      .then((value): CommandTaskOutput => {
        const out: Output = { ...value, state }
        this.lastOutput.set(taskId, { at: this.io.now(), value: out })
        return out
      })
      .catch((err: unknown): CommandTaskOutput => {
        if (isUnknownTaskError(err)) return { state: 'gone' }
        // A slow answer: the last known output beats an error.
        const last = this.lastOutput.get(taskId)
        if (last) return { ...last.value, state }
        throw err
      })
      .finally(() => this.inflight.delete(taskId))
    this.inflight.set(taskId, request)
    return request
  }

  /** `stop_task`: kill a running command (the CLI reports it killed). */
  async stop(taskId: string): Promise<void> {
    const command = this.commands.get(taskId)
    if (this.disposed || !command || command.snapshot.status !== 'running') {
      throw new Error(`command task ${taskId} is not running`)
    }
    await this.io.request({ subtype: 'stop_task', task_id: taskId }, TASK_REQUEST_TIMEOUT_MS)
  }

  /** `background_tasks`: move a running foreground command to the background (Ctrl+B). */
  async background(toolUseId: string): Promise<boolean> {
    if (this.disposed) return false
    const command = [...this.commands.values()].find(
      (c) =>
        c.snapshot.toolUseId === toolUseId &&
        c.snapshot.status === 'running' &&
        !c.snapshot.backgrounded
    )
    if (!command) return false
    const reply = await this.io.request(
      { subtype: 'background_tasks', tool_use_id: toolUseId },
      TASK_REQUEST_TIMEOUT_MS
    )
    return payload(reply).backgrounded === true
  }

  dispose(): void {
    this.disposed = true
    this.commands.clear()
    this.inflight.clear()
    this.lastOutput.clear()
  }

  private startCommand(ev: CliTaskEvent, toolUseId: string): CommandTaskEvent {
    const snapshot: CommandTaskEvent = {
      kind: 'command-task',
      taskId: ev.taskId,
      toolUseId,
      status: 'running',
      backgrounded: ev.backgrounded ?? false,
      ...(ev.description ? { description: ev.description } : {}),
      startedAt: this.callStarts.get(toolUseId) ?? this.io.now()
    }
    this.commands.set(ev.taskId, { snapshot, finalRead: false })
    return snapshot
  }

  private async readOutput(taskId: string): Promise<Omit<Output, 'state'>> {
    const reply = await this.io.request(
      { subtype: 'get_task_output', task_id: taskId },
      TASK_REQUEST_TIMEOUT_MS
    )
    const p = payload(reply)
    const output = typeof p.output === 'string' ? p.output : ''
    return {
      output,
      totalBytes: typeof p.total_bytes === 'number' ? p.total_bytes : Buffer.byteLength(output),
      truncated: p.truncated === true
    }
  }

  private async readFinalOutput(snapshot: CommandTaskEvent): Promise<void> {
    try {
      const out = await this.readOutput(snapshot.taskId)
      if (this.disposed) return
      this.io.emit({
        kind: 'command-task-output',
        taskId: snapshot.taskId,
        toolUseId: snapshot.toolUseId,
        ...out
      })
    } catch {
      // The process went away or the CLI no longer has it: the card keeps the
      // last live output it showed; nothing to save.
    }
  }
}

/** The CLI's own status words → ours (`stopped` = killed by `stop_task`). */
function commandStatus(status: string): CommandTaskStatus | null {
  if (status === 'running' || status === 'pending') return 'running'
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'killed' || status === 'stopped') return 'killed'
  return null
}

/**
 * The `sub-agent` event the adapter emitted before command tasks existed —
 * unchanged, so its consumers (reducer row, watchdog progress) are too.
 */
function subAgent(ev: CliTaskEvent): AgentEvent {
  return {
    kind: 'sub-agent',
    phase: 'in-flight',
    toolUseId: ev.toolUseId ?? '',
    parentToolUseId: ev.parentToolUseId,
    description: ev.description,
    status: ev.status,
    summary: ev.summary,
    usage: ev.usage,
    raw: ev.raw
  }
}

/** A control reply's payload (the driver resolves `{response: {...}}`). */
function payload(reply: unknown): Record<string, unknown> {
  const r = (reply as { response?: unknown } | null)?.response
  return r && typeof r === 'object' ? (r as Record<string, unknown>) : {}
}

function isUnknownTaskError(err: unknown): boolean {
  return err instanceof Error && /no (shell|.*task)/i.test(err.message)
}
