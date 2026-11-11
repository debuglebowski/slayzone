import type { AgentEvent } from './agent-events'
import type { ChatAttachment } from './chat-attachments'
export interface ComputerChatBackup {
  id: string
  createdAt: number
  kind: 'manual' | 'auto'
  sizeBytes: number
  events: number
  conversations: number
  /** Incomplete incoming migrations deferred to a later completed snapshot. */
  deferredConversations?: number
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
  error?: string
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
/** Original task file version in a read-only computer archive. */
export interface ArchivedArtifactVersion {
  artifactId: string
  name: string
  contentHash: string
  size: number
  versionNum: number
  versionName: string | null
  createdAt: string
}
/** Current saved working bytes, captured without inventing a history version. */
export interface ArchivedArtifactOriginal {
  artifactId: string
  name: string
  contentHash: string
  size: number
  workingCopy: true
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
  archiveFile(
    computerId: string,
    archiveId: string,
    conversationId: string,
    artifactId: string,
    contentHash: string
  ): Promise<{ name: string; data: string }>
}

export interface ChatAvailability {
  state:
    | 'ready'
    | 'offline'
    | 'preparing'
    | 'migrating'
    | 'unassigned'
    | 'paused'
    | 'deleted'
    | 'unavailable'
    | 'upgrading'
  computer: { id: string; name: string } | null
  /** 'unavailable' only: why, when the hub knows (e.g. its computer was removed). */
  reason?: string
  waitingForAgents?: boolean
  /** Hub recovery watermark. A ready computer can have missed live notifications. */
  recoveryGeneration?: string
}
export function chatAvailabilityMessage(
  status: ChatAvailability
): { title: string; detail: string } | null {
  const name = status.computer?.name ?? 'its computer'
  switch (status.state) {
    case 'ready':
    // Computer initialization is part of the client's normal chat load. Only
    // exceptional states need a separate explanation or recovery action.
    case 'preparing':
      return null
    case 'offline':
      return {
        title: `${name} is offline`,
        detail: 'Chat is stored there. Connect that computer to load history and send messages.'
      }
    case 'unavailable':
      return {
        title: 'Chat history unavailable',
        // A known reason repeats the title as its first sentence: show the rest.
        detail: status.reason
          ? status.reason.replace(/^Chat history unavailable\.\s*/, '')
          : `${name} did not return this conversation. Recover saved history from its chat backups, or reconnect the original computer. No empty history was created.`
      }
    case 'upgrading':
      return {
        title: `${name} update waiting`,
        detail:
          'Finish or stop its running work to complete the update. Stopping for this update keeps the current message in history. Chat opens after the computer updates.'
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
