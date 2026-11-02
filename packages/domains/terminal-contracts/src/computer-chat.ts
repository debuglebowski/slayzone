import type { AgentEvent } from './agent-events'
import type { ChatAttachment } from './chat-attachments'
export interface ComputerChatBackup {
  id: string
  createdAt: number
  kind: 'manual' | 'auto'
  sizeBytes: number
  events: number
  conversations: number
  readOnlyRestore: true
  providerResumable: false
  error?: string
}
export interface ComputerChatArchive {
  id: string
  backupId: string
  createdAt: number
  readOnly: true
  providerResumable: false
}
export interface ComputerChatBackupPolicy {
  autoEnabled: boolean
  intervalMinutes: number
  maxAutoBackups: number
}
export interface ArchivedChatConversation {
  id: string
  taskId: string
  tabId: string
  mode: string
  events: number
  title?: string | null
}
export interface ArchivedChatPage {
  events: Array<{ seq: number; at: number; event: AgentEvent }>
  hasMore: boolean
  nextSeq: number
}
export interface ArchivedChatRecordPage {
  records: Array<{ cursor: number; kind: string; id: string; value: unknown }>
  hasMore: boolean
  nextCursor: number
}
export interface ChatComputerOps {
  listBackups(computerId: string): Promise<ComputerChatBackup[]>
  createBackup(computerId: string, id: string): Promise<ComputerChatBackup>
  deleteBackup(computerId: string, id: string): Promise<void>
  restoreBackup(
    computerId: string,
    backupId: string,
    archiveId: string
  ): Promise<ComputerChatArchive>
  backupSettings(computerId: string): Promise<ComputerChatBackupPolicy>
  configureBackups(computerId: string, settings: ComputerChatBackupPolicy): Promise<void>
  listArchives(computerId: string): Promise<ComputerChatArchive[]>
  archiveConversations(computerId: string, archiveId: string): Promise<ArchivedChatConversation[]>
  archiveRead(
    computerId: string,
    archiveId: string,
    conversationId: string,
    afterSeq: number
  ): Promise<ArchivedChatPage>
  archiveRecords(
    computerId: string,
    archiveId: string,
    conversationId: string,
    afterCursor: number
  ): Promise<ArchivedChatRecordPage>
  archiveAttachment(
    computerId: string,
    archiveId: string,
    conversationId: string,
    ref: ChatAttachment
  ): Promise<{ data: string }>
}

export interface ChatAvailability {
  state: 'ready' | 'offline' | 'preparing' | 'migrating' | 'unassigned' | 'paused' | 'deleted'
  computer: { id: string; name: string } | null
  waitingForAgents?: boolean
}
export function chatAvailabilityMessage(
  status: ChatAvailability
): { title: string; detail: string } | null {
  const name = status.computer?.name ?? 'its computer'
  switch (status.state) {
    case 'ready':
      return null
    case 'offline':
      return {
        title: `${name} is offline`,
        detail: 'Chat is stored there. Connect that computer to load history and send messages.'
      }
    case 'preparing':
      return {
        title: `Opening chat on ${name}`,
        detail: 'Preparing its storage. This usually takes a moment.'
      }
    case 'migrating':
      return status.waitingForAgents
        ? {
            title: 'Chat migration waiting',
            detail: `Stop this task’s agents to move its history to ${name}.`
          }
        : {
            title: `Moving chat to ${name}`,
            detail: 'History becomes available when the verified transfer completes.'
          }
    case 'unassigned':
      return { title: 'Choose a computer', detail: 'Assign a computer to this task to use chat.' }
    case 'paused':
      return { title: 'Chat paused', detail: 'Restore or unarchive this task to continue.' }
    case 'deleted':
      return { title: 'Chat deleted', detail: 'This conversation is no longer available.' }
  }
}
