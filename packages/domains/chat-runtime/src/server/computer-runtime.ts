import {
  createChatTransport,
  createConversationRegistry,
  createChatOps,
  createChatQueueRuntime,
  type TransportDeps
} from '@slayzone/terminal/runtime'
import type { SlayzoneDb } from '@slayzone/platform'
import { openChatStorage } from './storage'
import { createLocalChatData, type ChatMetadataUpdate } from './local-data'

export function createComputerChatRuntime(opts: {
  stateDir: string
  hubScope: string
  computerId: string
  transport?: Partial<TransportDeps>
  onMetadata?: (update: ChatMetadataUpdate) => void
}) {
  const storage = openChatStorage(opts)
  const local = createLocalChatData(storage, opts.onMetadata)
  const conversations = createConversationRegistry()
  const transport = createChatTransport(opts.transport, conversations)
  const queueRuntime = createChatQueueRuntime(transport)
  const ops = createChatOps({
    dataOps: local.data,
    onStateChange: opts.transport?.onStateChange,
    onChatEvent: (tabId, event) => {
      if (event.kind === 'user-message' && !event.history && event.id)
        local.set(tabId, 'prompt', event.id, {
          id: event.id,
          taskId: local.owner(tabId).taskId,
          agentId: local.owner(tabId).mode,
          text: event.text,
          createdAt: Date.now(),
          cliSessionId: transport.getSessionInfo(tabId)?.sessionId ?? null
        })
    },
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
  return {
    storage,
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
      await transport.shutdownAll()
      storage.close()
    }
  }
}
