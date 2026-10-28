import type { TypedEmitter } from '@slayzone/platform/events'
import type { createChatOps } from './runtime/chat-handlers'
import type { createChatQueueOps, ChatQueueEventMap } from './runtime/chat-queue-handlers'
import type { ChatEventMap } from './runtime/chat-transport-manager'

// Host deps of the `chat.*` router: ops + queue ops (built by the composition root)
// and the two streaming emitters its subscriptions read. The composition root
// (`apps/hub/src/composition.ts`) injects them via `setChatDeps()`; a router call
// before that throws.
export type ChatDeps = {
  ops: ReturnType<typeof createChatOps>
  queueOps: ReturnType<typeof createChatQueueOps>
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
