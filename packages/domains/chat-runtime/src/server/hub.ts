/**
 * `@slayzone/chat-runtime/hub`: what the HUB uses — ownership, migration, the relay
 * to computers, lifecycle, recovery. No chat agent runtime and no chat storage:
 * those run on computers (`./server`, lint:server-boundary).
 */
export { chatStorageMode, terminalStorageMode } from './storage-mode'
export type { ChatBootstrap, ChatMetadataUpdate, ChatMetadataSnapshot } from './local-data'
export {
  createChatOwnershipStore,
  type ChatOwnershipStore,
  type HubChatOwnership
} from './hub-ownership'

export {
  createChatMigration,
  type ChatMigrationSource,
  type ChatComputerRequest
} from './migration'
export { createLegacyChatSource, type LegacyChatDiagnostics } from './legacy-source'
export { legacyChatTabContentSql, legacyChatTaskContentSql } from './legacy-census'
export { createHubChatRelay } from './hub-relay'
export { createHubProviderConfigStore } from './hub-provider-config'

export { createChatLifecycle } from './hub-lifecycle'

export { createChatRecovery } from './hub-recovery'

export { computerArtifactRequestSchema } from './artifacts'

export { createChatAvailability } from './hub-availability'
export { createChatFolderDeletions } from './hub-folders'
export { createChatMigrationAttachmentReader } from './migration-attachments'
