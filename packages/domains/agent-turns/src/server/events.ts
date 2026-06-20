import { TypedEmitter } from '@slayzone/platform/events'

export type AgentTurnsEventMap = {
  /** Emitted on every recorded turn boundary; payload is the worktree path. */
  'agent-turns:changed': [worktreePath: string]
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
 * Domain event bus for captured user prompts. `capturePrompt` emits
 * `agent-prompts:changed` here; the tRPC `agentPrompts.onChanged` subscription
 * wraps it so each renderer refetches the affected task's prompt list.
 */
export const agentPromptsEvents = new TypedEmitter<AgentPromptsEventMap>()
