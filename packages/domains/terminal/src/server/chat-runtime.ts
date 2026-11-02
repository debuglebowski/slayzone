/** Host-independent chat composition seams. No router or Electron imports. */
export {
  createChatTransport,
  type ChatTransport,
  type TransportDeps,
  type CreateChatOpts
} from './runtime/chat-transport-manager'
export { createConversationRegistry, type ConversationRegistry } from './runtime/live-conversations'
export {
  createChatOps,
  type ChatHandlerOpts,
  type ClaudeSessionReader
} from './runtime/chat-handlers'
export { createChatQueueRuntime, type ChatQueueRuntime } from './runtime/chat-queue-handlers'
export type { ChatDataOps, ProviderConfigEntry } from './runtime/chat-data-ops'
export type { ChatQueueData } from './runtime/chat-queue-data'
export type { ChatThreadStore } from './chat-threads-store'
export type { TimelineWrite, TimelineCheckpointRow } from './chat-timeline-store'
export type { ChatAttachmentReader } from './agents/chat-attachment-reader'
export type { ChatBackend } from './runtime/chat-proc-handle'
export type {
  WorkspaceCaptureBackend,
  WorkspaceChangesStore
} from './runtime/chat-workspace-tracker'

export type { ChatEventMap } from './runtime/chat-transport-manager'
export type { ChatQueueEventMap } from './runtime/chat-queue-handlers'
export type {
  ChatDeps,
  ChatCatalog,
  ChatCatalogOperation,
  ChatCatalogContext
} from './chat-router-deps'

export { supportsChatMode } from './agents/registry'
export type { ChatTerminalState } from './runtime/chat-transport-manager'

export { defaultConversationRegistry } from './runtime/live-conversations'
