import { TypedEmitter } from '@slayzone/platform/events'

/** One recorded turn boundary, as subscribers see it. */
export interface AgentTurnsChange {
  worktreePath: string
  taskId: string
}

export type AgentTurnsEventMap = {
  /**
   * Emitted on every recorded turn boundary: the checkout and the task that recorded
   * it (the event's owner check: §9 Phase 7b, never a path).
   */
  'agent-turns:changed': [change: AgentTurnsChange]
}

/**
 * Domain event bus for agent-turn boundaries. `recordTurnBoundary` emits
 * `agent-turns:changed` here; the tRPC `agentTurns.onChanged` subscription
 * wraps it in an observable so each renderer connection refetches its own list.
 *
 * The legacy `webContents.send('agent-turns:changed')` broadcast still runs in
 * parallel until the renderer drops IPC (slice 5).
 */
export const agentTurnsEvents = new TypedEmitter<AgentTurnsEventMap>()

export type AgentPromptsEventMap = {
  /** Emitted whenever a user prompt is captured; payload is the task id. */
  'agent-prompts:changed': [taskId: string]
}

/**
 * Domain event bus for captured user prompts. The agent-hook route (a prompt the
 * computer captured) and the hub's chat relay (a chat prompt saved) emit
 * `agent-prompts:changed` here; the tRPC `agentPrompts.onChanged` subscription
 * wraps it so each renderer refetches the affected task's prompt list.
 */
export const agentPromptsEvents = new TypedEmitter<AgentPromptsEventMap>()
