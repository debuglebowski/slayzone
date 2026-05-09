import { useCallback, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSubscription } from '@trpc/tanstack-react-query'
import type { QueuedChatMessage } from '@slayzone/terminal/shared'
import { useTRPC } from '@slayzone/transport/client'

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
  const queueQuery = useQuery(trpc.chat.queue.list.queryOptions({ tabId }))
  const items: QueuedChatMessage[] = (queueQuery.data ?? []) as QueuedChatMessage[]

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: trpc.chat.queue.list.queryKey({ tabId }) })
  }, [queryClient, trpc, tabId])

  useSubscription(
    trpc.chat.onQueueChanged.subscriptionOptions(undefined, {
      onData: ({ tabId: changedTabId }) => {
        if (changedTabId === tabId) invalidate()
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

  const pushMutation = useMutation(trpc.chat.queue.push.mutationOptions({ onSuccess: invalidate }))
  const removeMutation = useMutation(trpc.chat.queue.remove.mutationOptions({ onSuccess: invalidate }))
  const clearMutation = useMutation(trpc.chat.queue.clear.mutationOptions({ onSuccess: invalidate }))

  const push = useCallback(
    async (send: string, original: string) => {
      await pushMutation.mutateAsync({ tabId, send, original })
    },
    [tabId, pushMutation]
  )

  const remove = useCallback(async (id: string) => {
    await removeMutation.mutateAsync({ id })
  }, [removeMutation])

  const clear = useCallback(async () => {
    await clearMutation.mutateAsync({ tabId })
  }, [tabId, clearMutation])

  return { items, push, remove, clear }
}
