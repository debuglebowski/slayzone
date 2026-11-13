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

/**
 * Why a chat's history is unavailable: its computer was removed for good (deleted, or
 * missing), or a computer that holds the chat did not return it.
 */
export type ChatUnavailableReason = 'computer-removed' | 'not-returned'
export const CHAT_UNAVAILABLE_TITLE = 'Chat history unavailable'
/** Why, without the title ({@link CHAT_UNAVAILABLE_TITLE}). `computerName`: who did not return it. */
export function chatUnavailableDetail(
  reason: ChatUnavailableReason,
  computerName = 'Its computer'
): string {
  switch (reason) {
    case 'computer-removed':
      return 'Its computer was removed. Connect a computer that holds this chat (e.g. the same machine re-enrolled with its chat data) to restore it.'
    case 'not-returned':
      return `${computerName} did not return this conversation. Recover saved history from its chat backups, or reconnect the original computer. No empty history was created.`
  }
}
/** As an error message: the title, then why. */
export function chatUnavailableMessage(reason: ChatUnavailableReason): string {
  return `${CHAT_UNAVAILABLE_TITLE}. ${chatUnavailableDetail(reason)}`
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
  /** 'unavailable' only: why, when the hub knows. */
  reasonCode?: ChatUnavailableReason
  /**
   * 'unavailable' only: why, as text without the title — for clients that predate
   * `reasonCode` (a newer hub's text reads right there too).
   */
  reason?: string
  waitingForAgents?: boolean
  /**
   * `offline` only: a connected computer reported holding this chat — possibly the
   * offline one enrolled again under a new id (`computers.replace` moves its work).
   */
  heldBy?: { id: string; name: string }
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
      if (status.heldBy)
        return {
          title: `${name} is offline`,
          detail:
            status.heldBy.name === name
              ? `Another computer named ${name} holds this chat, possibly this one enrolled again. If so, replace the offline ${name} with it in Settings → Connections.`
              : `${status.heldBy.name} holds this chat. If ${status.heldBy.name} is ${name} enrolled again, replace ${name} with it in Settings → Connections.`
        }
      return {
        title: `${name} is offline`,
        detail: 'Chat is stored there. Connect that computer to load history and send messages.'
      }
    case 'unavailable':
      return {
        title: CHAT_UNAVAILABLE_TITLE,
        detail: status.reasonCode
          ? chatUnavailableDetail(status.reasonCode, name)
          : (status.reason ?? chatUnavailableDetail('not-returned', name))
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
