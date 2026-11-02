import { createChatRetention } from './retention'
import { parseChatInvocation } from '../shared'
import { createLocalArtifacts } from './artifacts'
import { createChatBackups } from './backups'
import { createLocalPrompts } from './prompts'
import { createChatTransfers } from './transfers'
import { createLocalWorkspaceStore } from './workspace-store'
import { createChatInvoker } from './invocation'
import { createLocalAttachments } from './attachments'
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
import { createLocalChatData, type ChatMetadataUpdate } from './local-data'
import { randomUUID } from 'node:crypto'

export function createComputerChatRuntime(opts: {
  stateDir: string
  hubScope: string
  computerId: string
  hasExternalTaskWork?(taskId: string): boolean
  sessionReader?: ClaudeSessionReader
  transport?: Partial<TransportDeps>
  onMetadata?: (update: ChatMetadataUpdate) => void
}) {
  const storage = openChatStorage(opts)
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
  const prompts = createLocalPrompts(storage)
  const local = createLocalChatData(storage, opts.onMetadata)
  const transfers = createChatTransfers(storage)
  transfers.collectActivated()
  const attachments = createLocalAttachments(storage, local)
  const artifacts = createLocalArtifacts(storage, local, attachments)
  const backups = createChatBackups(storage)
  const workspaceStore = createLocalWorkspaceStore(storage, local)
  const conversations = createConversationRegistry()
  const backend = opts.transport?.backend
  const transport = createChatTransport(
    {
      ...opts.transport,
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
  let retention: ReturnType<typeof createChatRetention> | undefined
  const queueRuntime = createChatQueueRuntime({
    ...transport,
    getSessionTerminalState: (tabId) =>
      retention?.isPruning(storage.forTab(tabId)?.identity.id ?? '')
        ? null
        : transport.getSessionTerminalState(tabId),
    isReadyForQueuedMessage: (tabId) =>
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
  retention = createChatRetention({
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
    }
  })
  const retentionService = retention
  return {
    diagnosticsConfig,
    configureDiagnostics,
    invoke: async (input: unknown) =>
      retentionService.access(parseChatInvocation(input).route.id, () => invoke(input)),
    retention: retentionService,
    captureHook: prompts.capture,
    prompts: prompts.list,
    storage,
    transfers,
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
    async deleteConversation(identity: import('../shared').ConversationIdentity) {
      const closing = transport.removeSession(identity.tabId)
      storage.applyTombstone(identity)
      await closing
      attachments.collectGarbage()
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
        transfers.removeTask(taskId)
        attachments.collectGarbage()
        artifacts.collectGarbage()
        storage.checkpoint()
      }
      return applied
    },
    async close() {
      if (closed) return
      closed = true
      await retentionService.close()
      await backups.close()
      await queueRuntime.close()
      await transport.shutdownAll()
      storage.close()
    }
  }
}
