import { useCallback, useEffect, useRef, useState } from 'react'
import { useSubscription } from '@trpc/tanstack-react-query'
import type { QueuedChatMessage } from '@slayzone/terminal/shared'
import { useTRPC, useTRPCClient } from '@slayzone/transport/client'

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
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const [items, setItems] = useState<QueuedChatMessage[]>([])

  const refetch = useCallback(async () => {
    const list = await trpcClient.chat.queue.list.query({ tabId })
    setItems(list as QueuedChatMessage[])
  }, [tabId, trpcClient])

  useEffect(() => {
    void refetch()
  }, [refetch])

  useSubscription(
    trpc.chat.onQueueChanged.subscriptionOptions(undefined, {
      onData: ({ tabId: changedTabId }) => {
        if (changedTabId === tabId) void refetch()
      },
    }),
  )

  const onDrainedRef = useRef(onDrained)
  onDrainedRef.current = onDrained
  useSubscription(
    trpc.chat.onQueueDrained.subscriptionOptions(undefined, {
      onData: ({ tabId: drainedTabId, original }) => {
        if (drainedTabId === tabId) onDrainedRef.current?.(original)
      },
    }),
  )

  const push = useCallback(
    async (send: string, original: string) => {
      await trpcClient.chat.queue.push.mutate({ tabId, send, original })
    },
    [tabId]
  )

  const remove = useCallback(async (id: string) => {
    await trpcClient.chat.queue.remove.mutate({ id })
  }, [])

  const clear = useCallback(async () => {
    await trpcClient.chat.queue.clear.mutate({ tabId })
  }, [tabId])

  return { items, push, remove, clear }
}
