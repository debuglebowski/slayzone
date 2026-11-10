import type { AgentEvent } from '@slayzone/terminal-contracts'

/** Storage identity is independent of a provider session id, which may not exist yet. */
export interface ConversationIdentity {
  id: string
  taskId: string
  tabId: string
  mode: string
  epoch: number
}
export interface ChatTabTransition {
  id: string
  from: ConversationIdentity
  to: ConversationIdentity
  next: ConversationIdentity
}
export interface StoredChatEvent {
  seq: number
  at: number
  event: AgentEvent
}
/** Every record kind a conversation holds (a transfer refuses any other). */
export const CHAT_RECORD_KINDS = [
  'draft',
  'queue',
  'prompt',
  'thread',
  'workspace',
  'attachment',
  'settings',
  'timeline',
  'pinned-message'
] as const
export type ChatRecordKind = (typeof CHAT_RECORD_KINDS)[number]
export interface ChatRecord {
  kind: ChatRecordKind
  id: string
  value: unknown
  at: number
}
export interface CommandReceipt {
  id: string
  hash: string
  state: 'accepted' | 'delivered'
  result: unknown
  at?: number
  resultExpired?: boolean
  method?: string
}
export interface ChatMigrationSnapshot {
  version: 1
  migrationId: string
  identity: ConversationIdentity
  events: StoredChatEvent[]
  records: ChatRecord[]
  receipts: CommandReceipt[]
  hash: string
}
export interface ChatOwnership {
  identity: ConversationIdentity
  state: 'active' | 'frozen' | 'prepared' | 'deleted'
  migrationId: string | null
  migrationHash: string | null
}
export * from './protocol'
export * from './task-data'
export interface ChatTransferHeader {
  format: 'slayzone-chat'
  version: 1
  migrationId: string
  identity: ConversationIdentity
  events: number
  records: number
  receipts: number
}
export interface ChatTransferManifest {
  header: ChatTransferHeader
  hash: string
  bytes: number
}
export * from './session-ledger'
export * from './agent-turns'
export * from './task-paths'
