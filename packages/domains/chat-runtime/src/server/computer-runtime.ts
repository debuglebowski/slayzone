import { createChatRetention } from './retention'
import { parseChatInvocation, type ChatTabTransition } from '../shared'
import { createLocalArtifacts } from './artifacts'
import { createChatBackups } from './backups'
import { createLocalPrompts } from './prompts'
import { createChatTransfers } from './transfers'
import { createSessionMoves, sessionLedgerMoveImport } from './session-moves'
import { createLocalWorkspaceStore } from './workspace-store'
import { createChatInvoker } from './invocation'
import { createLocalAttachments } from './attachments'
import { createChatBlobBackfill, type ChatBlobBackfillOptions } from './chat-blob-backfill'
import { createEventMarkerBackfill, type EventMarkerBackfillOptions } from './event-marker-backfill'
import { createStorageCompaction, type StorageCompactionOptions } from './storage-compaction'
import {
  createChatTransport,
  createConversationRegistry,
  createChatOps,
  createChatQueueRuntime,
  type TransportDeps,
  type ClaudeSessionReader
} from '@slayzone/terminal/runtime'
import type { SlayzoneDb } from '@slayzone/platform'
import { openChatStorage } from './storage'
import { createLocalChatData, type ChatBootstrap, type ChatMetadataUpdate } from './local-data'
import { randomUUID } from 'node:crypto'
import { createComputerTaskData, type DataImportKinds } from './task-data'
import { createSessionLedgerService } from './session-ledger-service'
import type { ConversationHealIo } from './conversation-heal'
import { sessionLedgerImports } from './session-ledger-imports'
import { historyImports } from './history-imports'
import { chatSettingsImport } from './chat-settings-import'
import { createTaskPaths, taskPathImport } from './task-paths'
import { createAgentTurns, type TurnGit } from './agent-turns'

/** No turn git wired (a runtime without a checkout): every turn operation refuses. */
const refuseTurnGit = () =>
  Promise.reject(new Error('Agent turns are unavailable on this computer'))
const refusingTurnGit: TurnGit = {
  canonical: refuseTurnGit,
  snapshot: refuseTurnGit,
  deleteTurnRef: refuseTurnGit,
  diffIsEmpty: refuseTurnGit,
  filterTurns: refuseTurnGit
}
import { prepareStoredTaskErasure, finishStoredTaskErasure } from './erase-stored-task'

export function createComputerChatRuntime(opts: {
  stateDir: string
  hubScope: string
  computerId: string
  /** Offline maintenance must not run another task's scheduled retention/backups. */
  maintenance?: boolean
  hasExternalTaskWork?(taskId: string): boolean
  sessionReader?: ClaudeSessionReader
  transport?: Partial<TransportDeps>
  onMetadata?: (update: ChatMetadataUpdate) => void
  /** Kinds of hub data this computer accepts (`data.import`); default: the built-in ones. */
  dataImports?: DataImportKinds
  /** This computer's disk and checkout, jailed: the session ledger's conversation heal. */
  healIo?: ConversationHealIo
  /** Turn git on this computer, jailed (agent-turn snapshots); none = turns refused. */
  turnGit?: TurnGit
  /** Event-blob backfill of pre-v13 rows; default: automatic unless `maintenance`. */
  blobBackfill?: Partial<
    Pick<ChatBlobBackfillOptions, 'automatic' | 'sliceBytes' | 'idleMs' | 'freeBytes'>
  >
  /** Event-marker backfill of pre-marker conversations (FU5); default: automatic unless `maintenance`. */
  markerBackfill?: Partial<
    Pick<EventMarkerBackfillOptions, 'automatic' | 'sliceBytes' | 'idleMs' | 'startDelayMs'>
  >
  /** Storage compaction tuning (tests); automatic reclaim defaults to off under `maintenance`. */
  compaction?: Partial<Omit<StorageCompactionOptions, 'storage' | 'backfillDone' | 'log'>>
  /** The computer's log (`computer.log`): maintenance progress, never chat content. */
  log?: (line: string) => void
}) {
  const storage = openChatStorage(opts)
  // Register before artifact purge listeners: every deletion delivery captures
  // retry identifiers before its source records disappear, including old clients.
  storage.onTaskPurge((taskId) => storage.compose((raw) => prepareStoredTaskErasure(raw, taskId)))
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
  let sessionsChanged: (tabId: string) => void = () => undefined
  // Task worktree paths / base dirs (robustness plan §9, P0, Phase 7a): only here.
  const taskPaths = createTaskPaths(storage)
  const local = createLocalChatData(storage, opts.onMetadata, ledger, (tabId) =>
    sessionsChanged(tabId)
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
  const artifacts = createLocalArtifacts(storage, local, attachments)
  const backups = createChatBackups(storage, { automatic: !opts.maintenance })
  const workspaceStore = createLocalWorkspaceStore(storage, local)
  const conversations = createConversationRegistry()
  const backend = opts.transport?.backend
  const userInputSessions = new Set<string>()
  const transport = createChatTransport(
    {
      ...opts.transport,
      beforeSpawn: (tabId) => {
        const owner = storage.forTab(tabId)
        if (
          !owner ||
          owner.state !== 'active' ||
          storage.taskLifecycle(owner.identity.taskId).state !== 'active' ||
          storage.getRecord(owner.identity.id, 'settings', 'tab-transition-pending')
        )
          throw new Error(
            'Chat provider transition or lifecycle change prevents starting this writer'
          )
        opts.transport?.beforeSpawn?.(tabId)
      },
      userInputTracker: {
        mark: (id) => {
          userInputSessions.add(id)
        },
        clear: (id) => {
          userInputSessions.delete(id)
        },
        has: (id) => userInputSessions.has(id)
      },
      diagnostic: (tabId, event) => {
        const config = diagnosticsConfig()
        if (!config.enabled || (event.level === 'debug' && !config.verbose)) return
        const owner = storage.forTab(tabId)
        if (
          !owner ||
          owner.state !== 'active' ||
          storage.taskLifecycle(owner.identity.taskId).state !== 'active'
        )
          return
        storage.putRecord(owner.identity.id, owner.identity.epoch, {
          kind: 'settings',
          id: `diagnostic:${randomUUID()}`,
          value: event,
          at: event.tsMs ?? Date.now()
        })
        opts.transport?.diagnostic?.(tabId, event)
      },
      ...(backend
        ? {
            backend: {
              spawn: (spec) => {
                if (storage.taskLifecycle(spec.taskId).state !== 'active')
                  throw new Error('Task chat is paused or deleted')
                return backend.spawn(spec)
              }
            }
          }
        : {}),
      attachmentReader: attachments.reader,
      workspaceStore
    },
    conversations
  )
  sessionsChanged = (tabId) => transport.chatEvents.emit('sessions-changed', tabId)

  let retention: ReturnType<typeof createChatRetention> | undefined
  const transitioning = (tabId: string) => {
    const owner = storage.forTab(tabId)
    return !owner || !!storage.getRecord(owner.identity.id, 'settings', 'tab-transition-pending')
  }
  const queueRuntime = createChatQueueRuntime({
    ...transport,
    ensureSpawned: (tabId) => {
      if (transitioning(tabId))
        return Promise.reject(new Error('Chat provider transition is pending'))
      return transport.ensureSpawned(tabId)
    },
    dispatchUserMessage: (tabId, message) => {
      if (transitioning(tabId)) throw new Error('Chat provider transition is pending')
      return transport.dispatchUserMessage(tabId, message)
    },
    getSessionTerminalState: (tabId) =>
      transitioning(tabId) || retention?.isPruning(storage.forTab(tabId)?.identity.id ?? '')
        ? null
        : transport.getSessionTerminalState(tabId),
    isReadyForQueuedMessage: (tabId) =>
      !transitioning(tabId) &&
      !retention?.isPruning(storage.forTab(tabId)?.identity.id ?? '') &&
      transport.isReadyForQueuedMessage(tabId)
  })
  const ops = createChatOps({
    dataOps: local.data,
    sessionReader: opts.sessionReader,
    onStateChange: opts.transport?.onStateChange,
    transport,
    conversations,
    notifyQueueChanged: queueRuntime.notifyChatQueueChanged
  })
  // The legacy factory's db parameter is unused when both data adapters are supplied.
  const queueOps = queueRuntime.createChatQueueOps(
    {} as SlayzoneDb,
    local.queue,
    local.data.attachments
  )
  let closed = false
  const invoke = createChatInvoker({ storage, local, ops, queueOps })
  const tabTransitions = new Map<string, Promise<ChatTabTransition['to']>>()
  retention = createChatRetention({
    automatic: !opts.maintenance,
    storage,
    local,
    busy: (owner) => {
      const info = transport.getSessionInfo(owner.identity.tabId)
      return (
        Boolean(opts.hasExternalTaskWork?.(owner.identity.taskId)) ||
        Boolean(info?.pid && !info.ended) ||
        transport.isTurnOpen(owner.identity.tabId) ||
        transport
          .listChatSessions()
          .some((s) => s.taskId === owner.identity.taskId && !['dead', 'error'].includes(s.state))
      )
    },
    quiesce: async (id) => {
      const info = transport.getSessionInfo(id)
      await transport.removeSession(id)
      if (info)
        return async () => {
          await ops.hydrate({ taskId: info.taskId, tabId: id, mode: info.mode, cwd: info.cwd })
        }
    },
    collectGarbage: () => {
      attachments.collectGarbage()
      artifacts.collectGarbage()
    },
    changed: (id) => {
      queueRuntime.notifyChatQueueChanged(id)
      transport.chatEvents.emit('threads-changed', id)
      transport.chatEvents.emit('pinned-messages-changed', id)
    }
  })
  const retentionService = retention
  // Moves the screenshots saved inline before v13 out-of-line (crash fix 4).
  const blobBackfill = createChatBlobBackfill({
    ...opts.blobBackfill,
    storage,
    automatic: opts.blobBackfill?.automatic ?? !opts.maintenance,
    ...(opts.log ? { log: opts.log } : {}),
    // Its timeline reset closes a chat's session only through retention's own lock.
    withQuiesced: (owner, work, o) => retentionService.withQuiesced(owner, work, o),
    pruning: (id) => retentionService.isPruning(id),
    changed: (id) => {
      transport.chatEvents.emit('threads-changed', id)
      transport.chatEvents.emit('pinned-messages-changed', id)
    }
  })
  // Opt-in compaction of chat.sqlite (fu-2); a rebuild waits for the backfill above.
  const compaction = createStorageCompaction({
    automaticReclaim: !opts.maintenance,
    ...opts.compaction,
    storage,
    backfillDone: () => blobBackfill.done(),
    ...(opts.log ? { log: opts.log } : {})
  })
  // Content erasure stops a rebuild: its copy came from a snapshot holding that content.
  storage.onTaskPurge(() => compaction.abort('Content was erased during compaction; start again'))
  return {
    diagnosticsConfig,
    async relocateProject(
      projectId: string,
      source: string,
      target: string,
      remap: (path: string) => string
    ) {
      const records = storage
        .findRecords('settings', undefined, { id: 'bootstrap' })
        .filter((record) => (record.value as ChatBootstrap).projectId === projectId)
      const sessions = records
        .map((record) => transport.getSessionInfo((record.value as ChatBootstrap).identity.tabId))
        .filter((info): info is NonNullable<typeof info> => info !== null)
      if (sessions.some((info) => info.pid !== null && !info.ended))
        throw new Error('Stop running chat agents before relocating the project.')
      if (records.some((record) => storage.conversation(record.conversationId)?.state !== 'active'))
        throw new Error('Wait for chat transfers to finish before relocating the project.')
      await Promise.all(sessions.map((info) => transport.removeSession(info.tabId)))
      storage.transaction(() => {
        for (const record of records) {
          const value = record.value as ChatBootstrap
          const owner = storage.conversation(record.conversationId)!
          storage.putRecord(record.conversationId, owner.identity.epoch, {
            kind: 'settings',
            id: 'bootstrap',
            value: { ...value, cwd: remap(value.cwd) },
            at: Date.now()
          })
        }
        const taskIds = new Set([
          ...taskPaths.store.projectTaskIds(projectId),
          ...records.map((r) => (r.value as ChatBootstrap).identity.taskId)
        ])
        storage.compose((db) => {
          for (const taskId of taskIds) {
            const sessions = db
              .prepare('SELECT id, cwd FROM agent_sessions WHERE task_id=? AND cwd IS NOT NULL')
              .all(taskId) as Array<{ id: string; cwd: string }>
            for (const session of sessions)
              db.prepare('UPDATE agent_sessions SET cwd=? WHERE id=?').run(
                remap(session.cwd),
                session.id
              )
            const turns = db
              .prepare('SELECT id, worktree_path FROM agent_turns WHERE task_id=?')
              .all(taskId) as Array<{ id: string; worktree_path: string }>
            for (const turn of turns)
              db.prepare('UPDATE agent_turns SET worktree_path=? WHERE id=?').run(
                remap(turn.worktree_path),
                turn.id
              )
          }
        })
        taskPaths.store.relocateProject(projectId, source, target)
      })
      for (const info of sessions)
        await ops.hydrate({
          taskId: info.taskId,
          tabId: info.tabId,
          mode: info.mode,
          cwd: remap(info.cwd)
        })
    },
    taskData,
    ledger,
    turns,
    taskPaths,
    configureDiagnostics,
    invoke: async (input: unknown) =>
      retentionService.access(parseChatInvocation(input).route.id, () => invoke(input)),
    retention: retentionService,
    blobBackfill,
    markerBackfill,
    compaction,
    captureHook: prompts.capture,
    prompts: prompts.list,
    promptSummaries: prompts.summaries,
    storage,
    transfers,
    sessionMoves,
    attachments,
    backups,
    artifacts,
    workspaceStore,
    local,
    transport,
    conversations,
    ops,
    queueOps,
    events: transport.chatEvents,
    queueEvents: queueRuntime.chatQueueEvents,
    bootstrap: local.bootstrap,
    async transitionTab(value: ChatTabTransition) {
      storage.prepareTabTransition(value)
      if (storage.getRecord(value.from.id, 'settings', `tab-transition:${value.id}`))
        return storage.conversation(value.from.id)!.identity
      const current = tabTransitions.get(value.from.id)
      if (current) return current
      // Pending transition fences new commands, while the old writer can still
      // persist its final output/projection before its identity changes.
      const work = (async () => {
        await queueRuntime.settleTab(value.from.tabId)
        await transport.quiesceSession(value.from.tabId)
        await invoke.settle(value.from.id)
        return storage.commitTabTransition(value)
      })().finally(() => tabTransitions.delete(value.from.id))
      tabTransitions.set(value.from.id, work)
      return work
    },
    async deleteConversation(identity: import('../shared').ConversationIdentity) {
      const parents = storage
        .findRecords('thread', identity.taskId)
        .filter((r) => r.id === identity.tabId)
        .map((r) => storage.conversation(r.conversationId)?.identity.tabId)
      const closing = transport.removeSession(identity.tabId)
      storage.applyTombstone(identity)
      await closing
      transfers.removeConversation(identity.id)
      attachments.collectGarbage()
      for (const parent of parents) if (parent) transport.chatEvents.emit('threads-changed', parent)
      storage.checkpoint()
    },
    async applyTaskLifecycle(
      taskId: string,
      state: 'active' | 'paused' | 'deleted',
      revision: number
    ) {
      const previous = storage.taskLifecycle(taskId)
      if (previous.state === 'deleted') {
        const applied = storage.applyTaskLifecycle(taskId, state, revision)
        artifacts.cleanupDeletedTasks(taskId)
        transfers.removeTask(taskId)
        attachments.collectGarbage()
        artifacts.collectGarbage()
        storage.checkpoint()
        return applied
      }
      if (previous.revision >= revision) return previous
      // Close tabs synchronously before awaiting projection flushes. No late
      // subprocess output or queued command can restart this task after the fence.
      const closing =
        state !== 'active'
          ? storage.listForTask(taskId).map((o) => transport.removeSession(o.identity.tabId))
          : []
      const applied = storage.applyTaskLifecycle(taskId, state, revision)
      await Promise.all(closing)
      if (applied.state === 'deleted') {
        artifacts.cleanupDeletedTasks(taskId)
        transfers.removeTask(taskId)
        attachments.collectGarbage()
        artifacts.collectGarbage()
        storage.checkpoint()
      }
      return applied
    },
    async eraseTask(taskId: string, revision: number, stopExternal?: () => Promise<void>) {
      compaction.abort('Content was erased during compaction; start again')
      storage.compose((raw) => prepareStoredTaskErasure(raw, taskId))
      const closing = storage
        .listForTask(taskId)
        .map((o) => transport.removeSession(o.identity.tabId))
      const applied = storage.applyTaskLifecycle(taskId, 'deleted', revision)
      // Already deleted at a newer revision (the hub was restored from a
      // backup): the same deletion, erased again idempotently. A task this
      // computer has not deleted is never erased.
      if (applied.state !== 'deleted' || applied.revision < revision)
        throw new Error('Stale computer erasure request')
      await stopExternal?.()
      await Promise.all(closing)
      transfers.removeTask(taskId)
      artifacts.cleanupDeletedTasks(taskId)
      await artifacts.retryErasures(taskId)
      artifacts.collectGarbage()
      storage.compose((raw) => finishStoredTaskErasure(raw, storage.dir, taskId))
      await backups.eraseTask(taskId)
      // Needs-attention records name the task (and quote its errors): erased too.
      storage.deleteTaskFaults(taskId)
      return { taskId, revision: applied.revision, erased: true as const }
    },
    async close() {
      if (closed) return
      closed = true
      await compaction.close()
      await blobBackfill.close()
      await markerBackfill.close()
      await retentionService.close()
      await backups.close()
      await queueRuntime.close()
      await transport.shutdownAll()
      transfers.close()
      await artifacts.close()
      storage.close()
    }
  }
}
