import type { AgentEvent } from './agent-events'
import type { ChatAttachment } from './chat-attachments'
import type { ChatBlobChunk } from './chat-blobs'
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
/**
 * A computer's chat store on disk and its space maintenance (fu-2): a one-time rebuild
 * (`VACUUM INTO` off the main thread, swapped in) switches it to incremental
 * auto-vacuum; from then on freed space is returned in short slices.
 */
export type ComputerChatStorageJobKind = 'rebuild' | 'reclaim'
export type ComputerChatStoragePhase =
  | 'copying'
  | 'catching-up'
  | 'swapping'
  | 'reclaiming'
  | 'done'
  | 'failed'
  | 'cancelled'
export interface ComputerChatStorageResult {
  at: number
  kind: ComputerChatStorageJobKind
  beforeBytes: number
  afterBytes: number
  reclaimedBytes: number
  durationMs: number
  /** How long writes waited for the swap (rebuild only). */
  holdMs: number | null
}
export interface ComputerChatStorageJob {
  id: string
  kind: ComputerChatStorageJobKind
  /** Started by the computer itself (incremental reclaim), not by a user. */
  automatic: boolean
  phase: ComputerChatStoragePhase
  startedAt: number
  /** 0..1 */
  progress: number
  /** Why it failed or was cancelled; what it waits for. */
  message: string | null
  result: ComputerChatStorageResult | null
}
export interface ComputerChatStorageState {
  supported: true
  fileBytes: number
  walBytes: number
  /** Bytes in use: (pages − free pages) × page size. */
  liveBytes: number
  /** Free pages × page size: what a compaction returns. */
  reclaimableBytes: number
  autoVacuum: 'none' | 'full' | 'incremental'
  /** Worth offering to the user. */
  worthIt: boolean
  /** The event-blob backfill finished (a rebuild waits for it). */
  backfillDone: boolean
  freeDiskBytes: number
  /** Free disk a rebuild needs now (0 for an incremental reclaim). */
  requiredDiskBytes: number
  /** The running job, or the last one this run (until the next starts). */
  job: ComputerChatStorageJob | null
  /** The last successful one, kept in the store. */
  last: ComputerChatStorageResult | null
}
/** `supported: false`: the computer predates storage compaction (update it). */
export type ComputerChatStorageStatus = ComputerChatStorageState | { supported: false }
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
  /** The computer's chat store on disk and its compaction; `{supported:false}` = an older computer. */
  storageStatus(computerId: string): Promise<ComputerChatStorageStatus>
  /** Start a compaction (rebuild, or reclaim on an incremental store); refused with a reason. */
  compactStorage(computerId: string): Promise<ComputerChatStorageJob>
  cancelStorageCompaction(computerId: string): Promise<void>
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
  /** One chunk of an image / file an archived conversation's events reference (`chat-blobs`). */
  archiveBlob(
    computerId: string,
    archiveId: string,
    conversationId: string,
    sha256: string,
    offset: number
  ): Promise<ChatBlobChunk>
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
  hibernated?: true
  lastSeenAt?: number
  lastMemoryPercent?: number
  lastMemoryPressure?: boolean
  lastLiveAgents?: number
  /** A known computer boot or chat reconciliation is still in progress. */
  historyWaiting?: true
  /** Socket survived a hub freeze; liveness is being confirmed, not known offline. */
  recovering?: boolean
  /**
   * `offline` only: a connected computer reported holding this chat — possibly the
   * offline one enrolled again under a new id (`computers.replace` moves its work).
   */
  heldBy?: { id: string; name: string }
  /** Hub recovery watermark. A ready computer can have missed live notifications. */
  recoveryGeneration?: string
}
/**
 * Whether the chat's computer can run its agent now: 'ready', or 'preparing' (the
 * computer's normal chat load). Anything else (offline, upgrading, paused, …) fails
 * a start — a restore waits for the computer instead of attempting one.
 */
export function chatComputerCanStart(state: ChatAvailability['state']): boolean {
  return state === 'ready' || state === 'preparing'
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
      if (status.recovering)
        return {
          title: `Reconnecting to ${name}`,
          detail: 'Confirming the computer connection. Your agents may still be running.'
        }
      if (status.heldBy)
        return {
          title: `${name} is offline`,
          detail:
            status.heldBy.name === name
              ? `Another computer named ${name} holds this chat, possibly this one enrolled again. If so, replace the offline ${name} with it on the hub’s Computers tab in Settings.`
              : `${status.heldBy.name} holds this chat. If ${status.heldBy.name} is ${name} enrolled again, replace ${name} with it on the hub’s Computers tab in Settings.`
        }
      if (status.lastSeenAt !== undefined) {
        const lastSeen = new Date(status.lastSeenAt).toLocaleString()
        const agents =
          status.lastLiveAgents === undefined ? '' : ` with ${status.lastLiveAgents} live agents`
        const memory =
          status.lastMemoryPercent === undefined
            ? ''
            : ` Last reported memory use was ${status.lastMemoryPercent}%${agents}${status.lastMemoryPressure ? ' (under pressure)' : ''}.`
        return {
          title: status.lastMemoryPressure ? `${name} stopped responding` : `${name} is offline`,
          detail: `Last seen ${lastSeen}.${memory} Reconnect it to load history and send messages.`
        }
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
