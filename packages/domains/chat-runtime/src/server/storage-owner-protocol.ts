import type { MessagePort } from 'node:worker_threads'
import type Database from 'better-sqlite3'
import type { TxnSigOf } from '@slayzone/platform'
import type { SerializedError } from '@slayzone/platform/sqlite-worker'
import type { ChatExportReader, ChatStorage } from './storage'

export const CHAT_STORAGE_OWNER_KIND = 'slayzone-chat-storage-owner-v1'
export interface StorageOwnerData {
  kind: typeof CHAT_STORAGE_OWNER_KIND
  stateDir: string
  hubScope: string
  checkpointIntervalMs?: number
  control: MessagePort
}

export const STORAGE_METHODS = [
  'conversation',
  'listFaults',
  'retryFault',
  'deleteFault',
  'deleteTaskFaults',
  'pendingTaskCleanup',
  'completeTaskCleanup',
  'queueMessageIdentity',
  'inventory',
  'listForTask',
  'createConversation',
  'prepareTabTransition',
  'commitTabTransition',
  'forTab',
  'isTabDeleted',
  'getRecord',
  'findRecords',
  'appendAt',
  'extractEventBlobs',
  'eventBlobHashes',
  'readEventBlob',
  'legacyEventSizes',
  'legacyEvent',
  'rewriteLegacyEvent',
  'hasTimeline',
  'writeTimeline',
  'dropTimelinePagesFrom',
  'dropTimelineStep',
  'timelineRecord',
  'timelinePageIds',
  'timelineSummaries',
  'searchTimelinePages',
  'uncoveredMarkerConversations',
  'backfillEventMarkers',
  'maintenanceCursor',
  'setMaintenanceCursor',
  'maintenanceDone',
  'completeMaintenance',
  'clearHistory',
  'append',
  'read',
  'readPage',
  'pageBounds',
  'readMatching',
  'tailStart',
  'records',
  'storeId',
  'nextSeq',
  'stateVersion',
  'repairAttachmentPins',
  'hasConversationContent',
  'putRecord',
  'removeRecord',
  'acceptCommand',
  'completeCommand',
  'receipt',
  'freeze',
  'unfreeze',
  'exportConversation',
  'hasExportReaders',
  'stage',
  'activate',
  'migrationCheckpoint',
  'taskLifecycles',
  'taskLifecycle',
  'applyTaskLifecycle',
  'applyTombstone',
  'deleteConversation',
  'backupTo',
  'hasBlobLeases',
  'checkpoint'
] as const satisfies readonly (keyof ChatStorage)[]
export type StorageMethod = (typeof STORAGE_METHODS)[number]
export type StorageCall = {
  [K in StorageMethod]: { method: K; args: Parameters<ChatStorage[K]> }
}[StorageMethod]
export type StorageCallResult = Awaited<ReturnType<ChatStorage[StorageMethod]>>
export const EXPORT_READER_METHODS = ['eventPage', 'recordPage', 'receiptPage', 'resolve'] as const
export type ExportReaderMethod = (typeof EXPORT_READER_METHODS)[number]
export type ExportReaderMetadata = Pick<
  ChatExportReader,
  'identity' | 'migrationId' | 'eventCount' | 'recordCount' | 'receiptCount'
>
export type ExportReaderOpened = ExportReaderMetadata & { token: string }
export type ExportReaderCall =
  | { operation: 'open'; args: Parameters<ChatStorage['openExportReader']> }
  | { operation: 'close'; token: string }
  | {
      operation: 'read'
      token: string
      call: {
        [K in ExportReaderMethod]: { method: K; args: Parameters<ChatExportReader[K]> }
      }[ExportReaderMethod]
    }
export interface StorageLeaseCall {
  operation: 'blob' | 'secondary' | 'release'
  label: string
  ttlMs?: number
}
export type StorageMaintenanceCall =
  | { method: 'fileStats' | 'secondaryConnections' | 'tempPath' | 'connectionEpoch'; args: [] }
  | { method: 'swapIn'; args: [string] }
  | { method: 'pauseCheckpointer' | 'resumeCheckpointer' | 'checkpointNow'; args: [] }
export type ControlRequest = {
  type: 'request'
  id: number
  operation: 'open' | 'close' | 'checkpoint'
  final?: boolean
}
export type OwnerControl = ControlRequest | { type: 'purged'; taskId: string }
export type HostControl =
  | { type: 'reply'; id: number; ok: true; result?: unknown }
  | { type: 'reply'; id: number; ok: false; error: SerializedError }
  | { type: 'failed'; message: string }
  | { type: 'recovered' }

// One compiled, typed command surface; no function or transaction closure crosses threads.
export type StorageOwnerTxns = {
  'chatStorage.call': (db: Database.Database, params: StorageCall) => StorageCallResult
  'chatStorage.flush': (db: Database.Database) => Promise<void>
  'chatStorage.prepareClose': (db: Database.Database) => void
  'chatStorage.lease': (db: Database.Database, params: StorageLeaseCall) => string | void
  'chatStorage.maintenance': (db: Database.Database, params: StorageMaintenanceCall) => unknown
  'chatStorage.exportReader': (db: Database.Database, params: ExportReaderCall) => unknown
  'chatStorage.exportFault': (
    db: Database.Database,
    params: { id: string; error: SerializedError }
  ) => void
}
export type StorageOwnerTxnRegistry = TxnSigOf<StorageOwnerTxns>

// New synchronous backend methods must be classified rather than silently omitted.
type BackendMethod = {
  [K in keyof ChatStorage]: ChatStorage[K] extends (...args: never[]) => unknown ? K : never
}[keyof ChatStorage]
type HostOrSpecialMethod =
  | 'transaction'
  | 'compose'
  | 'onTaskPurge'
  | 'close'
  | 'shutdown'
  | 'flush'
  | 'acquireBlobLease'
  | 'openExportReader' // Private tokens keep snapshot functions/connections on the owner.
  | 'recordExportBlobFault' // Error identity needs explicit structured serialization.
  | 'stageTransfer' // Iterables must stay worker-local; transfer-file commands migrate separately.
type MustBeMapped<T extends never> = T
export type StorageOwnerSurfaceComplete = MustBeMapped<
  Exclude<BackendMethod, StorageMethod | HostOrSpecialMethod>
>
