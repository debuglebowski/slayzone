import { randomUUID } from 'node:crypto'
import type { AgentEvent, AgentExecution } from '@slayzone/terminal-contracts'
import {
  endedSubAgentPhase,
  isAsyncAgentLaunch,
  normalizeSubAgentPhase
} from '../../shared/sub-agent-lifecycle'

/** Claude's stream has no universal native turn id. A CLI that reports
 * `command_lifecycle` bounds each execution itself (measured on 2.1.326):
 * `started` precedes every output of its message, a turn's result precedes the
 * next message's `started`, a message taken mid-turn starts inside the running
 * turn, and a turn the CLI starts by itself has no `started`. From the first
 * lifecycle record on, executions begin at `started` (or at self-started output),
 * never at the host's write — output still in the pipe when the host writes
 * keeps its own owner. Without lifecycle records ownership stays `ordered`
 * (inferred from the write). Ownership of live tools/helpers/jobs is retained
 * across root turns, and identifiable duplicate results are suppressed. */
export class ClaudeTurnAttribution {
  private current: AgentExecution | undefined
  /** The CLI reports `command_lifecycle`: it, not the host's write, starts executions. */
  private lifecycle = false
  /** Written while a self-started turn ran (no lifecycle seen yet): it starts after that turn. */
  private pending: string | undefined
  /** That message's turn begins once the self-started turn's end was emitted (`settle`). */
  private startAfter: string | undefined
  private readonly tools = new Map<string, AgentExecution>()
  private readonly parents = new Map<string, string>()
  private readonly helpers = new Map<string, boolean>()
  private readonly jobs = new Map<string, AgentExecution>()
  private readonly completedJobs = new Set<string>()
  private readonly results = new Set<string>()
  private lastResultIndex = -1

  constructor(private readonly emitStart: (event: AgentEvent) => void) {}

  /** The host wrote message `messageId` (`joinCurrent`: added to the running turn). */
  begin(messageId?: string, joinCurrent = false): void {
    // Its `started` begins (or joins) the execution; nothing is known before.
    if (this.lifecycle && messageId) return
    // The CLI started a turn by itself: the message waits for that turn's end.
    if (messageId && !joinCurrent && this.current && !this.current.messageId) {
      this.pending = messageId
      return
    }
    if (this.current && (!messageId || joinCurrent || this.current.messageId === messageId)) return
    this.current = {
      turnId: messageId ?? randomUUID(),
      source: 'ordered',
      ...(messageId ? { messageId } : {})
    }
    this.emitStart({ kind: 'turn-started', execution: { ...this.current } })
  }

  /** `command_lifecycle started`: a message taken while a turn runs joins it. */
  private started(messageId: string): void {
    if (this.current) {
      // The process's first write began it before the CLI showed it reports
      // lifecycle: it is CLI-bounded now, and the host hears so.
      if (this.current.messageId === messageId && this.current.source !== 'lifecycle') {
        this.current = { ...this.current, source: 'lifecycle' }
        this.emitStart({ kind: 'turn-started', execution: { ...this.current } })
      }
      return
    }
    this.current = { turnId: messageId, source: 'lifecycle', messageId }
    this.emitStart({ kind: 'turn-started', execution: { ...this.current } })
  }

  /** A turn the CLI started by itself: output with no `started` before it. */
  private selfStarted(): void {
    this.current = { turnId: randomUUID(), source: this.lifecycle ? 'lifecycle' : 'ordered' }
    this.emitStart({ kind: 'turn-started', execution: { ...this.current } })
  }

  attribute(event: AgentEvent): AgentEvent | null {
    // These acknowledgements already identify their message, independently of
    // whichever execution happens to be current when they arrive.
    if (
      event.kind === 'command-lifecycle' ||
      event.kind === 'user-replay' ||
      event.kind === 'heartbeat'
    ) {
      if (event.kind === 'command-lifecycle') {
        this.lifecycle = true
        this.pending = undefined
        if (event.state === 'started') this.started(event.commandUuid)
        if (event.state === 'cancelled' && this.current?.messageId === event.commandUuid) {
          this.current = undefined
          this.clearFinishedTools()
        }
      }
      return event
    }
    if (event.kind === 'result' && !event.parentToolUseId) {
      if (event.uuid && this.results.has(event.uuid)) return null
      if (event.resultIndex !== undefined && event.resultIndex <= this.lastResultIndex) return null
      if (event.uuid) {
        this.results.add(event.uuid)
        // Result identities only: no transcript text; bounded for long sessions.
        if (this.results.size > 256) this.results.delete(this.results.values().next().value!)
      }
      if (event.resultIndex !== undefined) this.lastResultIndex = event.resultIndex
    }
    const toolId = 'toolUseId' in event ? event.toolUseId : undefined
    const parent =
      event.parentToolUseId ??
      (toolId
        ? (this.parents.get(toolId) ??
          (event.kind === 'permission-request' && this.helpers.has(toolId) ? toolId : undefined))
        : undefined)
    let execution = event.execution ?? (parent ? this.tools.get(parent) : undefined)
    if (!execution && toolId) execution = this.tools.get(toolId)
    if (!execution && (event.kind === 'command-task' || event.kind === 'command-task-output'))
      execution = this.jobs.get(event.taskId)
    const mainProgress =
      !parent &&
      [
        'assistant-text',
        'assistant-thinking',
        'tool-call',
        'stream-message-start',
        'stream-block-start',
        'stream-block-delta'
      ].includes(event.kind)
    if (
      !execution &&
      !parent &&
      !this.current &&
      (mainProgress || (this.lifecycle && event.kind === 'result'))
    )
      this.selfStarted()
    if (!execution && !parent) execution = this.current
    const owned = {
      ...event,
      ...(execution ? { execution: { ...execution } } : {}),
      ...(parent ? { parentToolUseId: parent } : {})
    }
    if (execution) {
      if (event.kind === 'tool-call') {
        this.tools.set(event.id, execution)
        if (parent) this.parents.set(event.id, parent)
      }
      if (event.kind === 'sub-agent') {
        const known = this.helpers.get(event.toolUseId)
        const backgrounded = known === true || event.backgrounded === true
        const phase =
          known === undefined || backgrounded
            ? (endedSubAgentPhase(event.status) ?? normalizeSubAgentPhase(event.phase))
            : normalizeSubAgentPhase(event.phase)
        if (phase === 'in-flight') {
          this.helpers.set(event.toolUseId, backgrounded)
          this.tools.set(event.toolUseId, execution)
        } else {
          this.helpers.delete(event.toolUseId)
          this.tools.delete(event.toolUseId)
          this.parents.delete(event.toolUseId)
          this.clearFinishedTools()
        }
      }
      if (event.kind === 'tool-result') {
        if (isAsyncAgentLaunch(event)) this.helpers.set(event.toolUseId, true)
        else if (this.helpers.get(event.toolUseId) !== true) this.helpers.delete(event.toolUseId)
        if (!this.helpers.has(event.toolUseId)) {
          this.tools.delete(event.toolUseId)
          this.parents.delete(event.toolUseId)
        }
      }
      if (event.kind === 'command-task') {
        if (event.status === 'running') this.jobs.set(event.taskId, execution)
        else {
          // Final output can follow the end notification. Retain its owner;
          // bound ended jobs even when an older CLI never sends final output.
          this.completedJobs.add(event.taskId)
          if (this.completedJobs.size > 256) {
            const id = this.completedJobs.values().next().value!
            this.completedJobs.delete(id)
            this.jobs.delete(id)
          }
        }
      }
      if (event.kind === 'command-task-output' && this.completedJobs.delete(event.taskId))
        this.jobs.delete(event.taskId)
    }
    if (event.kind === 'result' && !parent) {
      this.current = undefined
      for (const [id, backgrounded] of this.helpers) if (!backgrounded) this.helpers.delete(id)
      this.clearFinishedTools()
      this.startAfter = this.pending
      this.pending = undefined
    }
    return owned
  }

  /** Call after emitting an attributed event: begins a turn its end released. */
  settle(): void {
    const next = this.startAfter
    this.startAfter = undefined
    if (next) this.begin(next)
  }

  private clearFinishedTools(): void {
    for (const id of this.tools.keys()) {
      if (this.current && this.tools.get(id)?.turnId === this.current.turnId) continue
      let parent: string | undefined = id
      const seen = new Set<string>()
      while (parent && !this.helpers.has(parent) && !seen.has(parent)) {
        seen.add(parent)
        parent = this.parents.get(parent)
      }
      if (!parent || !this.helpers.has(parent)) {
        this.tools.delete(id)
        this.parents.delete(id)
      }
    }
  }

  dispose(): void {
    this.current = undefined
    this.lifecycle = false
    this.tools.clear()
    this.parents.clear()
    this.helpers.clear()
    this.jobs.clear()
    this.completedJobs.clear()
    this.results.clear()
  }
}
