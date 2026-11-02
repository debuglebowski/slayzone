import type { ChatComputerOps, ChatAvailability, AgentEvent } from '@slayzone/terminal-contracts'
import type { TypedEmitter } from '@slayzone/platform/events'
import type { createChatOps } from './runtime/chat-handlers'
import type { createChatQueueOps, ChatQueueEventMap } from './runtime/chat-queue-handlers'
import type { ChatEventMap } from './runtime/chat-transport-manager'

// Host deps of the `chat.*` router: ops + queue ops (built by the composition root)
// and the two streaming emitters its subscriptions read. The composition root
// (`apps/hub/src/composition.ts`) injects them via `setChatDeps()`; a router call
// before that throws.
type AsyncCapable<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => R | Promise<Awaited<R>>
    : never
}
export type ChatCatalogOperation =
  | 'getAutoEligibility'
  | 'listSkills'
  | 'listCommands'
  | 'listAgents'
  | 'listFiles'
  | 'bumpAutocompleteUsage'
  | 'getAutocompleteUsage'
export interface ChatCatalogContext {
  taskId?: string
  tabId?: string
}
export type ChatCatalog = {
  [K in ChatCatalogOperation]: (
    context: ChatCatalogContext,
    ...args: Parameters<ReturnType<typeof createChatOps>[K]>
  ) => Promise<Awaited<ReturnType<ReturnType<typeof createChatOps>[K]>>>
}
export type ChatDeps = {
  testing?: {
    seedEvents(tabId: string, fromSeq: number, events: Record<string, unknown>[]): Promise<void>
    readEvents(
      tabId: string,
      afterSeq: number,
      limit: number
    ): Promise<Array<{ seq: number; event: AgentEvent }>>
    projection(
      tabId: string,
      action: 'read' | 'corrupt-page' | 'corrupt-checkpoint'
    ): Promise<{
      checkpoint: { version: string; seq: number; data: string } | null
      lastSeq: number
    }>
    seedPrompts(
      taskId: string,
      prompts: Array<{
        id: string
        agentId: string
        text: string
        cliSessionId: string | null
        createdAt: number
      }>
    ): Promise<void>
  }
  ops: AsyncCapable<ReturnType<typeof createChatOps>>
  queueOps: AsyncCapable<ReturnType<typeof createChatQueueOps>>
  catalog?: ChatCatalog
  computers?: ChatComputerOps
  availability?(tabId: string): Promise<ChatAvailability>
  events: TypedEmitter<ChatEventMap>
  queueEvents: TypedEmitter<ChatQueueEventMap>
}

let chatDeps: ChatDeps | null = null

export function setChatDeps(deps: ChatDeps): void {
  chatDeps = deps
}

export function getChatDeps(): ChatDeps {
  if (!chatDeps) throw new Error('chatDeps not initialized — call setChatDeps() in main host first')
  return chatDeps
}
