/** Native store composition. Called only inside the canonical owner in the online runtime. */
import { createChatScopeAuthority } from './scope-authority'
import { createLocalArtifacts } from './artifacts'
import { createChatBackups } from './backups'
import { createLocalPrompts } from './prompts'
import { createChatTransfers } from './transfers'
import { createSessionMoves, sessionLedgerMoveImport } from './session-moves'
import { createLocalWorkspaceStore } from './workspace-store'
import { createLocalAttachments } from './attachments'
import { createEventMarkerBackfill } from './event-marker-backfill'
import { createLocalChatData } from './local-data'
import { createComputerTaskData } from './task-data'
import { createSessionLedgerService } from './session-ledger-service'
import { sessionLedgerImports } from './session-ledger-imports'
import { historyImports } from './history-imports'
import { chatSettingsImport } from './chat-settings-import'
import { createTaskPaths, taskPathImport } from './task-paths'
import { createAgentTurns, type TurnGit } from './agent-turns'
import { prepareStoredTaskErasure } from './erase-stored-task'
import type { ChatStorage } from './storage'
import type { ComputerChatRuntimeOptions } from './computer-runtime'
import { usageCursorStore } from './usage-cursors'
import type { UploadStaging } from './upload-staging'

const refuseTurnGit = () =>
  Promise.reject(new Error('Agent turns are unavailable on this computer'))
const refusingTurnGit: TurnGit = {
  canonical: refuseTurnGit,
  snapshot: refuseTurnGit,
  deleteTurnRef: refuseTurnGit,
  diffIsEmpty: refuseTurnGit,
  filterTurns: refuseTurnGit
}

export function createChatStoreServices(
  storage: ChatStorage,
  opts: ComputerChatRuntimeOptions,
  hooks: {
    sessionsChanged?(tabId: string): void
    failure?(error: unknown): void
    available?(): void
    artifactAccess?<T>(taskId: string, work: () => Promise<T>): Promise<T>
    uploads?: UploadStaging
  } = {}
) {
  // Register before artifact purge listeners: every deletion delivery captures
  // retry identifiers before its source records disappear, including old clients.
  storage.onTaskPurge((taskId) =>
    storage.compose((raw) => prepareStoredTaskErasure(raw, taskId, storage.dir))
  )
  const diagnosticsConfig = () =>
    storage.getRecord<{ enabled: boolean; verbose: boolean }>(
      '__slz_settings__',
      'settings',
      'diagnostics-config'
    ) ?? { enabled: true, verbose: false }
  const configureDiagnostics = (value: { enabled: boolean; verbose: boolean }) => {
    storage.transaction(() => {
      storage.createConversation({
        id: '__slz_settings__',
        taskId: '__slz_settings__',
        tabId: '__slz_settings__',
        mode: 'claude-chat',
        epoch: 1
      })
      storage.putRecord('__slz_settings__', 1, {
        kind: 'settings',
        id: 'diagnostics-config',
        value,
        at: Date.now()
      })
    })
  }
  // Indexes conversations saved before `event_markers` (FU5), so session summaries
  // stop scanning every event of a task; a chat a summary had to scan goes first.
  const markerBackfill = createEventMarkerBackfill({
    ...opts.markerBackfill,
    storage,
    automatic: opts.markerBackfill?.automatic ?? !opts.maintenance,
    ...(opts.log ? { log: opts.log } : {})
  })
  const prompts = createLocalPrompts(storage, {
    uncovered: (ids) => markerBackfill.prioritize(ids)
  })
  // Agent-turn snapshots (robustness plan §9, P0): only here, never on the hub.
  const turns = createAgentTurns(storage, opts.turnGit ?? refusingTurnGit)
  // The agent-session ledger (robustness plan §9, P0): only here, never on the hub.
  const ledger = createSessionLedgerService(storage, { healIo: opts.healIo })
  // Bound once the transport exists: a session recorded before that has no listener.
  // Task worktree paths / base dirs (robustness plan §9, P0, Phase 7a): only here.
  const taskPaths = createTaskPaths(storage)
  const local = createLocalChatData(storage, opts.onMetadata, ledger, (tabId) =>
    hooks.sessionsChanged?.(tabId)
  )
  const taskData = createComputerTaskData({
    storage,
    computerId: opts.computerId,
    imports: opts.dataImports ?? {
      ...sessionLedgerImports,
      ...historyImports,
      'task-path': taskPathImport,
      'chat-settings': chatSettingsImport,
      'session-ledger-move': sessionLedgerMoveImport
    },
    providerConfig: local.providerConfig,
    taskPath: taskPaths.get
  })
  // A restarted runtime has no in-flight admission to renew these slots. Cancel
  // them before draining so a lost hub/host cannot block later accepted messages.
  local.cancelPendingQueueAdmissions()
  const transfers = createChatTransfers(storage)
  transfers.collectActivated()
  const sessionMoves = createSessionMoves(storage)
  const attachments = createLocalAttachments(storage, local)
  const artifacts = createLocalArtifacts(storage, local, attachments, hooks, hooks.uploads)
  const backups = createChatBackups(storage, {
    automatic: !opts.maintenance,
    workerFactory: opts.compaction?.workerFactory
  })
  const workspaceStore = createLocalWorkspaceStore(storage, local)
  return {
    storage,
    diagnosticsConfig,
    configureDiagnostics,
    markerBackfill,
    prompts,
    turns,
    ledger,
    taskPaths,
    local,
    taskData,
    transfers,
    sessionMoves,
    attachments,
    artifacts,
    backups,
    workspaceStore,
    authority: createChatScopeAuthority(storage),
    usageCursors: usageCursorStore(storage)
  }
}
export type ChatStoreServices = ReturnType<typeof createChatStoreServices>
