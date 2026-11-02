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

export function createComputerChatRuntime(opts: {
  stateDir: string
  hubScope: string
  computerId: string
  sessionReader?: ClaudeSessionReader
  transport?: Partial<TransportDeps>
  onMetadata?: (update: ChatMetadataUpdate) => void
}) {
  const storage = openChatStorage(opts)
  const prompts = createLocalPrompts(storage)
  const local = createLocalChatData(storage, opts.onMetadata)
  const transfers = createChatTransfers(storage)
  const attachments = createLocalAttachments(storage, local)
  const artifacts = createLocalArtifacts(storage, local, attachments)
  const backups = createChatBackups(storage)
  const workspaceStore = createLocalWorkspaceStore(storage, local)
  const conversations = createConversationRegistry()
  const backend = opts.transport?.backend
  const transport = createChatTransport(
    {
      ...opts.transport,
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
  const queueRuntime = createChatQueueRuntime(transport)
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
  return {
    invoke,
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
      await backups.close()
      await queueRuntime.close()
      await transport.shutdownAll()
      storage.close()
    }
  }
}
