import { randomUUID } from 'node:crypto'
import type { AgentEvent, AgentExecution } from '@slayzone/terminal-contracts'
import {
  endedSubAgentPhase,
  isAsyncAgentLaunch,
  normalizeSubAgentPhase
} from '../../shared/sub-agent-lifecycle'

/** Claude's stream has no universal native turn id. Keep ordered attribution
 * explicit, retain ownership of live tools/helpers/jobs across root turns, and
 * suppress identifiable duplicate results. An unseen result with neither a
 * turn id nor a previously observed uuid/index remains a protocol limitation. */
export class ClaudeTurnAttribution {
  private current: AgentExecution | undefined
  private readonly tools = new Map<string, AgentExecution>()
  private readonly parents = new Map<string, string>()
  private readonly helpers = new Map<string, boolean>()
  private readonly jobs = new Map<string, AgentExecution>()
  private readonly completedJobs = new Set<string>()
  private readonly results = new Set<string>()
  private lastResultIndex = -1

  constructor(private readonly emitStart: (event: AgentEvent) => void) {}

  begin(messageId?: string, joinCurrent = false): void {
    if (this.current && (!messageId || joinCurrent || this.current.messageId === messageId)) return
    this.current = {
      turnId: messageId ?? randomUUID(),
      source: 'ordered',
      ...(messageId ? { messageId } : {})
    }
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
      if (
        event.kind === 'command-lifecycle' &&
        event.state === 'cancelled' &&
        this.current?.messageId === event.commandUuid
      ) {
        this.current = undefined
        this.clearFinishedTools()
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
    if (!execution && !parent && mainProgress) this.begin()
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
    }
    return owned
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
    this.tools.clear()
    this.parents.clear()
    this.helpers.clear()
    this.jobs.clear()
    this.completedJobs.clear()
    this.results.clear()
  }
}
