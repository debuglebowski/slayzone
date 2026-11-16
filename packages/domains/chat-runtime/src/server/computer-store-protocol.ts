import type { createChatStoreFaults } from './computer-store-faults'
import type { StoreRequest } from './computer-store-requests'
import type { ComputerChatTestRequest } from './computer-testing-schema'
/** Private compiled store surface. Function implementations and transaction closures stay on the owner. */
import type { SerializedError } from '@slayzone/platform/sqlite-worker'
import type { ChatStoreServices } from './computer-chat-stores'
import type { ChatStoreJobs } from './computer-chat-store-jobs'
import type { ComputerStoreControl } from './computer-store-control'
import type { TurnGit } from './agent-turns'
import type { ConversationHealIo } from './conversation-heal'
import type { ChatMetadataUpdate } from './local-data'
import type { ChatOwnership, ConversationIdentity } from '../shared'
import type { TimelineRecordStore } from '@slayzone/terminal/timeline-records'
import type { ChatDataOps } from '@slayzone/terminal/runtime'

export type StoreModels = {
  faults: ReturnType<typeof createChatStoreFaults>
  requests: { handle(request: StoreRequest): Promise<unknown> }
  testing: { handle(request: ComputerChatTestRequest): Promise<unknown> }
  local: ChatStoreServices['local']
  ledger: Omit<ChatStoreServices['ledger'], 'db'>
  turns: Omit<ChatStoreServices['turns'], 'store'>
  taskPaths: Omit<ChatStoreServices['taskPaths'], 'store'>
  taskData: ChatStoreServices['taskData']
  transfers: ChatStoreServices['transfers']
  sessionMoves: ChatStoreServices['sessionMoves']
  attachments: ChatStoreServices['attachments']
  backups: ChatStoreServices['backups']
  artifacts: Omit<ChatStoreServices['artifacts'], 'store' | 'db' | 'publication'>
  artifactPublication: Pick<
    ChatStoreServices['artifacts']['publication'],
    'inspect' | 'publish' | 'status' | 'cancel'
  >
  workspaceStore: ChatStoreServices['workspaceStore']
  prompts: ChatStoreServices['prompts']
  usageCursors: ChatStoreServices['usageCursors']
  control: ComputerStoreControl
  retention: Pick<ChatStoreJobs['retention'], 'configure' | 'runNow'>
  blobBackfill: ChatStoreJobs['blobBackfill']
  markerBackfill: ChatStoreServices['markerBackfill']
  compaction: ChatStoreJobs['compaction']
}
type Fn = (...args: never[]) => unknown
export type FunctionPaths<T, D extends unknown[] = [1, 1, 1, 1]> = {
  [K in keyof T & string]: NonNullable<T[K]> extends Fn
    ? K
    : D extends [unknown, ...infer Rest]
      ? NonNullable<T[K]> extends object
        ? `${K}.${FunctionPaths<NonNullable<T[K]>, Rest>}`
        : never
      : never
}[keyof T & string]
export type AtPath<T, P extends string> = P extends `${infer K}.${infer R}`
  ? K extends keyof T
    ? AtPath<NonNullable<T[K]>, R>
    : never
  : P extends keyof T
    ? NonNullable<T[P]>
    : never
export type AsyncTree<T> = {
  [K in keyof T]: NonNullable<T[K]> extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : NonNullable<T[K]> extends object
      ? AsyncTree<NonNullable<T[K]>>
      : T[K]
}
export type AsyncStoreModels = Omit<
  { [K in keyof StoreModels]: AsyncTree<StoreModels[K]> },
  'local'
> & {
  local: Omit<AsyncTree<StoreModels['local']>, 'get' | 'data'> & {
    get<T>(...args: Parameters<StoreModels['local']['get']>): Promise<T | null>
    data: ChatDataOps
  }
}
export type StoreCall = {
  [G in keyof StoreModels]: {
    [M in FunctionPaths<StoreModels[G]>]: AtPath<StoreModels[G], M> extends (
      ...args: infer A
    ) => unknown
      ? { group: G; method: M; args: A; resumeToken?: string }
      : never
  }[FunctionPaths<StoreModels[G]>]
}[keyof StoreModels]
export type HostCall =
  | {
      [M in keyof TurnGit]: { group: 'turnGit'; method: M; args: Parameters<TurnGit[M]> }
    }[keyof TurnGit]
  | {
      [M in keyof ConversationHealIo]: {
        group: 'heal'
        method: M
        args: Parameters<ConversationHealIo[M]>
      }
    }[keyof ConversationHealIo]
  | { group: 'quiesce'; owner: ChatOwnership; token: string }
  | { group: 'test-tab'; tabId: string; action: 'busy' | 'remove' }
  | { group: 'restore'; token: string; resume: boolean }
export type StoreNotification =
  | { type: 'failure'; error: SerializedError }
  | { type: 'metadata'; update: ChatMetadataUpdate }
  | { type: 'sessions' | 'changed'; tabId: string; owner?: ConversationIdentity }
  | { type: 'log'; line: string }
export interface OnlineStoreData {
  computerId: string
  hostTurnGit?: boolean
  hostHeal?: boolean
  blobBackfill?: { automatic?: boolean; sliceBytes?: number; idleMs?: number }
  markerBackfill?: {
    automatic?: boolean
    sliceBytes?: number
    idleMs?: number
    startDelayMs?: number
  }
  compaction?: Partial<
    Record<
      | 'reclaimCheckMs'
      | 'reclaimThresholdBytes'
      | 'rebuildOfferBytes'
      | 'slicePages'
      | 'idleMs'
      | 'finalKeys'
      | 'finalBytes'
      | 'maxRounds'
      | 'copyBatchBytes'
      | 'copySyncBytes'
      | 'copyPauseMs',
      number
    >
  > & { automaticReclaim?: boolean }
}
export type TimelineCall =
  | { operation: 'open'; tabId: string; resumeToken?: string }
  | {
      operation: 'call'
      owner: ConversationIdentity
      storeId: string
      method: keyof TimelineRecordStore
      args: unknown[]
      resumeToken?: string
    }

export const STORE_METHODS = {
  faults: ['list', 'retry', 'discard'],
  requests: ['handle'],
  testing: ['handle'],
  local: [
    'data.threads.get',
    'data.threads.listForParent',
    'data.threads.list',
    'data.threads.create',
    'data.threads.setConversation',
    'data.threads.setClosed',
    'data.pinnedMessages.list',
    'data.pinnedMessages.pin',
    'data.pinnedMessages.unpin',
    'data.readProviderConfig',
    'data.writeChatMode',
    'data.writeChatModel',
    'data.writeChatEffort',
    'data.writeChatCollaboration',
    'data.writeChatFastMode',
    'data.clearChatConversationId',
    'data.readSetting',
    'data.getDefaultChatMode',
    'data.getModeDefaultFlags',
    'data.recordConversation',
    'data.isHonoredConversation',
    'data.getCurrentConversationId',
    'data.bumpLastInteraction',
    'data.prepareChatEvent',
    'data.readChatEventBlob',
    'data.persistChatEvent',
    'data.loadChatEventsPage',
    'data.chatEventsTailStart',
    'data.getNextSeqForTab',
    'data.clearChatEventsForTab',
    'data.loadUserMessageContent',
    'data.loadTimelineCheckpoint',
    'data.loadTimelinePages',
    'data.loadTimelineSummaries',
    'data.saveTimeline',
    'data.searchTimelinePages',
    'data.clearTimeline',
    'data.clearChatQueue',
    'data.buildMcpEnv',
    'data.resolveComputerId',
    'data.getTaskProjectId',
    'data.getProjectRoot',
    'data.bumpAutocompleteUsage',
    'data.getAutocompleteUsage',
    'data.saveCliSnapshot',
    'data.getCliSnapshot',
    'data.saveCliCommandDetails',
    'data.getCliCommandDetails',
    'data.saveCliModels',
    'data.getCliModels',
    'data.getTabState',
    'data.saveTabDraft',
    'data.saveTabScroll',
    'data.attachments.tab',
    'data.attachments.artifacts',
    'data.attachments.queued',
    'data.attachments.hasVersion',
    'queue.reserve',
    'queue.renewReservation',
    'queue.cancelReservation',
    'queue.list',
    'queue.replay',
    'queue.push',
    'queue.pop',
    'queue.update',
    'queue.move',
    'queue.requeue',
    'queue.remove',
    'queue.clear',
    'queue.getTabIdForItem',
    'bootstrap',
    'providerConfig',
    'owner',
    'get',
    'set',
    'remove',
    'metadata',
    'metadataSnapshot',
    'pendingMetadata',
    'cancelPendingQueueAdmissions',
    'repairQueueIdentities'
  ],
  ledger: [
    'handle',
    'isWrite',
    'recordConversation',
    'getCurrentConversationId',
    'isHonoredConversation',
    'sessionTasks'
  ],
  turns: ['handle'],
  taskPaths: ['handle', 'get', 'others', 'ofProject', 'byWorktree'],
  taskData: ['importBatch', 'read'],
  transfers: [
    'begin',
    'chunk',
    'manifestOf',
    'finish',
    'collectActivated',
    'removeTask',
    'removeConversation',
    'resume',
    'progress',
    'close'
  ],
  sessionMoves: ['exportTask', 'cliSessionIds', 'read', 'discard', 'forgetTask'],
  attachments: ['reader.read', 'readBlob', 'putPrepared', 'missing', 'put', 'collectGarbage'],
  backups: [
    'create',
    'list',
    'delete',
    'settings',
    'configure',
    'restore',
    'listArchives',
    'conversations',
    'read',
    'records',
    'attachment',
    'blob',
    'file',
    'eraseTask',
    'close'
  ],
  artifacts: [
    'invoke',
    'cleanupDeletedTasks',
    'close',
    'retryErasures',
    'deleteFolders',
    'deletedFolderInventory',
    'seal',
    'collectGarbage',
    'metadata'
  ],
  artifactPublication: ['inspect', 'publish', 'status', 'cancel'],
  workspaceStore: ['remove', 'begin', 'save', 'get', 'getFileDiff', 'recover'],
  retention: ['configure', 'runNow'],
  blobBackfill: ['runNow', 'done', 'close'],
  markerBackfill: ['runNow', 'prioritize', 'done', 'close'],
  compaction: [
    'status',
    'start',
    'cancel',
    'abort',
    'checkReclaim',
    'rebuildForErasure',
    'idle',
    'close'
  ],
  prompts: ['list', 'summaries', 'capture'],
  usageCursors: ['all', 'seed', 'commit'],
  control: [
    'prepareClose',
    'diagnosticsConfig',
    'configureDiagnostics',
    'retentionDays',
    'taskActive',
    'spawnOwner',
    'diagnostic',
    'agentState',
    'applyLifecycle',
    'deleteConversation',
    'prepareErasure',
    'finishErasure',
    'projectState',
    'projectTaskIds',
    'relocateProject'
  ]
} as const satisfies { [G in keyof StoreModels]: readonly FunctionPaths<StoreModels[G]>[] }

type Unmapped = {
  [G in keyof StoreModels]: Exclude<
    FunctionPaths<StoreModels[G]>,
    (typeof STORE_METHODS)[G][number] | (G extends 'local' ? 'data.timelineRecords' : never)
  >
}[keyof StoreModels]
type MustBeMapped<T extends never> = T
export type ComputerStoreSurfaceComplete = MustBeMapped<Unmapped>
