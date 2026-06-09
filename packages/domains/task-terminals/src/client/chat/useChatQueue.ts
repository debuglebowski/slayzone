import { useCallback, useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSubscription, useTRPC } from '@slayzone/transport/client'
import type { QueuedChatMessage } from '@slayzone/terminal/shared'

/**
 * Subscribe to the backend-persisted chat queue for one tab. The queue is
 * a single source of truth in SQLite (table `chat_queue`); this hook is
 * purely a subscriber + thin RPC facade.
 *
 * Fetches initial state on mount + on `tabId` change, refetches on
 * `chat.onQueueChanged` events (push, remove, clear, drain). The drain
 * callback is exposed separately so the consumer can bump autocomplete
 * usage counts with the raw `original` token after a drain dispatches.
 *
 * No optimistic update on push/remove/clear: the server broadcasts
 * `onQueueChanged` post-mutation and the subscription invalidates the list
 * query — the same single-source-of-truth flow the IPC version relied on.
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
  const queryClient = useQueryClient()

  const listQuery = useQuery(trpc.chat.queue.list.queryOptions({ tabId }, { enabled: !!tabId }))

  // Refetch on any queue mutation for this tab (push, remove, clear, drain).
  // Server fan-out is global; filter by tabId in onData.
  useSubscription(
    trpc.chat.onQueueChanged.subscriptionOptions(undefined, {
      enabled: !!tabId,
      onData: ({ tabId: changedTabId }) => {
        if (changedTabId === tabId) {
          void queryClient.invalidateQueries(trpc.chat.queue.list.queryFilter({ tabId }))
        }
      }
    })
  )

  const onDrainedRef = useRef(onDrained)
  useEffect(() => {
    onDrainedRef.current = onDrained
  })
  useSubscription(
    trpc.chat.onQueueDrained.subscriptionOptions(undefined, {
      enabled: !!tabId,
      onData: ({ tabId: drainedTabId, original }) => {
        if (drainedTabId === tabId) onDrainedRef.current?.(original)
      }
    })
  )

  const pushMutation = useMutation(trpc.chat.queue.push.mutationOptions())
  const removeMutation = useMutation(trpc.chat.queue.remove.mutationOptions())
  const clearMutation = useMutation(trpc.chat.queue.clear.mutationOptions())

  const push = useCallback(
    async (send: string, original: string) => {
      await pushMutation.mutateAsync({ tabId, send, original })
      // No optimistic update — onQueueChanged fires post-insert and triggers refetch.
    },
    [pushMutation, tabId]
  )

  const remove = useCallback(
    async (id: string) => {
      await removeMutation.mutateAsync({ id })
    },
    [removeMutation]
  )

  const clear = useCallback(async () => {
    await clearMutation.mutateAsync({ tabId })
  }, [clearMutation, tabId])

  return { items: listQuery.data ?? [], push, remove, clear }
}
