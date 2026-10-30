export * from './types'
export * from './terminal-state-labels'
export * from './dev-server'
export * from './strip-underline'
export * from './osc'
export * from './agent-events'
export {
  HOOK_SUPPORTED_AGENT_IDS,
  mapEventType,
  type AgentId,
  type AgentLifecycleEvent,
  type AgentLifecycleEventType
} from './agent-event-handler'
export * from './chat-mode'
export * from './chat-mode-catalog'
export * from './chat-model'
export * from './chat-model-catalog'
export * from './chat-effort'
export * from './chat-collaboration'
export * from './chat-fast-mode'
export * from './chat-capabilities'
export * from './chat-conversation'
export * from './chat-cli-commands'
export * from './chat-attachments'
export * from './chat-tab-state'
export * from './chat-synthetic-prompts'
export * from './key-sequences'
export * from './ansi'
export * from './link-regex'
export * from './loop-controller'
export * from './auto-start'
export * from './spawn-conversation-ids'
export type { ConversationOrigin } from './conversation-origin'
export * from './bg-shell-helpers'

/**
 * Session ids are `<taskId>:<…>`, except the project-wide agent panel's, which has
 * no task: `__global-agent-panel:<projectId>:<n>`.
 */
export const GLOBAL_AGENT_PANEL_SESSION_OWNER = '__global-agent-panel'

export function globalAgentPanelSessionId(projectId: string, index: number): string {
  return `${GLOBAL_AGENT_PANEL_SESSION_OWNER}:${projectId}:${index}`
}
