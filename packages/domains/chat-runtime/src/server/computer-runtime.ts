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
  const workspaceStore = createLocalWorkspaceStore(storage, local)
  const conversations = createConversationRegistry()
  const transport = createChatTransport(
    { ...opts.transport, attachmentReader: attachments.reader, workspaceStore },
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
    workspaceStore,
    local,
    transport,
    conversations,
    ops,
    queueOps,
    events: transport.chatEvents,
    queueEvents: queueRuntime.chatQueueEvents,
    bootstrap: local.bootstrap,
    async close() {
      if (closed) return
      closed = true
      await queueRuntime.close()
      await transport.shutdownAll()
      storage.close()
    }
  }
}
