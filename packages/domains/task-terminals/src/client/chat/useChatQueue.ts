import { useCallback, useEffect, useRef, useState } from 'react'
import type { QueuedChatMessage } from '@slayzone/terminal/shared'
import { getTrpcVanillaClient } from '@slayzone/transport/client'

/**
 * Subscribe to the backend-persisted chat queue for one tab. The queue is
 * a single source of truth in SQLite (table `chat_queue`); this hook is
 * purely a subscriber + thin RPC facade.
 */
export interface UseChatQueueResult {
  items: QueuedChatMessage[]
  push: (send: string, original: string) => Promise<void>
  remove: (id: string) => Promise<void>
  clear: () => Promise<void>
}

export function useChatQueue(
  tabId: string,
  onDrained?: (original: string) => void
): UseChatQueueResult {
  const [items, setItems] = useState<QueuedChatMessage[]>([])

  const refetch = useCallback(async () => {
    const list = await getTrpcVanillaClient().chat.queue.list.query({ tabId })
    setItems(list as QueuedChatMessage[])
  }, [tabId])

  useEffect(() => {
    void refetch()
    const sub = getTrpcVanillaClient().chat.onQueueChanged.subscribe(undefined, {
      onData: ({ tabId: changedTabId }) => {
        if (changedTabId === tabId) void refetch()
      },
    })
    return () => sub.unsubscribe()
  }, [tabId, refetch])

  const onDrainedRef = useRef(onDrained)
  onDrainedRef.current = onDrained
  useEffect(() => {
    const sub = getTrpcVanillaClient().chat.onQueueDrained.subscribe(undefined, {
      onData: ({ tabId: drainedTabId, original }) => {
        if (drainedTabId === tabId) onDrainedRef.current?.(original)
      },
    })
    return () => sub.unsubscribe()
  }, [tabId])

  const push = useCallback(
    async (send: string, original: string) => {
      await getTrpcVanillaClient().chat.queue.push.mutate({ tabId, send, original })
    },
    [tabId]
  )

  const remove = useCallback(async (id: string) => {
    await getTrpcVanillaClient().chat.queue.remove.mutate({ id })
  }, [])

  const clear = useCallback(async () => {
    await getTrpcVanillaClient().chat.queue.clear.mutate({ tabId })
  }, [tabId])

  return { items, push, remove, clear }
}
