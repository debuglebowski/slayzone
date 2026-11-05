/**
 * The work of ONE chat agent process that runs in the background — what a
 * terminal agent's hooks tell its agent tree (`agent-tree.ts`), read here from
 * the chat event stream instead:
 *   - sub-agents in flight (`sub-agent` events; when one goes to the background
 *     and ends follows `sub-agent-lifecycle.ts`, as the timeline's rows do).
 *     A BACKGROUND one still running after its turn is the tab's `background`
 *     state;
 *   - commands running as CLI tasks (`command-task` snapshots). A BACKGROUND one
 *     is a background job (the dot's jobs orbit).
 *
 * Pure: the transport feeds it every saved event and publishes the counts.
 * Everything belongs to the process, so its end (`process-exit`, or a
 * replacement) clears it.
 *
 * @module terminal/server/runtime/chat-background-work
 */
import type { AgentEvent } from '@slayzone/terminal-contracts'
import {
  endedSubAgentPhase,
  isAsyncAgentLaunch,
  normalizeSubAgentPhase
} from '../../shared/sub-agent-lifecycle'

export interface BackgroundWorkCounts {
  /** Background sub-agents still running. */
  subAgents: number
  /** Background commands still running. */
  jobs: number
}

export class ChatBackgroundWork {
  /** Sub-agents in flight: tool_use_id of the outer call → runs in the background. */
  private readonly subAgents = new Map<string, boolean>()
  /** Commands running: task id → runs in the background. */
  private readonly commands = new Map<string, boolean>()

  /** Fold one saved event in. */
  apply(event: AgentEvent): void {
    switch (event.kind) {
      case 'sub-agent': {
        const id = event.toolUseId
        if (!id) return
        const known = this.subAgents.get(id)
        if (known === undefined) {
          // A notification of a run that already ended (an orphan) opens nothing.
          const phase = endedSubAgentPhase(event.status) ?? normalizeSubAgentPhase(event.phase)
          if (phase === 'in-flight') this.subAgents.set(id, event.backgrounded === true)
          return
        }
        const backgrounded = known || event.backgrounded === true
        const phase = backgrounded
          ? (endedSubAgentPhase(event.status) ?? normalizeSubAgentPhase(event.phase))
          : normalizeSubAgentPhase(event.phase)
        if (phase === 'in-flight') this.subAgents.set(id, backgrounded)
        else this.subAgents.delete(id)
        return
      }
      case 'tool-result': {
        const known = this.subAgents.get(event.toolUseId)
        if (known === undefined || known) return
        // Launched in the background: it runs on; its notification ends it.
        if (isAsyncAgentLaunch(event)) this.subAgents.set(event.toolUseId, true)
        else this.subAgents.delete(event.toolUseId)
        return
      }
      case 'command-task':
        if (event.status === 'running') this.commands.set(event.taskId, event.backgrounded)
        else this.commands.delete(event.taskId)
        return
      case 'result':
      case 'interrupted':
        // The turn ended: only what runs in the background outlives it.
        for (const [id, bg] of this.subAgents) if (!bg) this.subAgents.delete(id)
        for (const [id, bg] of this.commands) if (!bg) this.commands.delete(id)
        return
      case 'process-exit':
        this.clear()
        return
      default:
        return
    }
  }

  /** The process is gone or replaced: nothing of it runs any more. */
  clear(): void {
    this.subAgents.clear()
    this.commands.clear()
  }

  counts(): BackgroundWorkCounts {
    let subAgents = 0
    for (const bg of this.subAgents.values()) if (bg) subAgents++
    let jobs = 0
    for (const bg of this.commands.values()) if (bg) jobs++
    return { subAgents, jobs }
  }
}
