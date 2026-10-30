/**
 * The tab's "Up next" queue: messages sent while a turn runs, kept by the hub (table
 * `chat_queue`) and sent by it, in order, when the agent is free. This hook only reads
 * it (`chat.queue.list`, reloaded on `chat.onQueueChanged` and whenever that
 * subscription (re)starts — a reconnect may have missed changes) and asks for changes.
 * Desktop's counterpart: `task-terminals/src/client/chat/useChatQueue.ts`.
 */
import type { QueuedChatMessage, UserContentBlock } from '@slayzone/terminal-contracts'
import { useSubscription } from '@slayzone/transport/client'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { newMessageId } from './ids'
import { useTRPC, useTRPCClient } from '../trpc'
import { useStableCallback } from './useStableCallback'

export interface ChatQueue {
  items: QueuedChatMessage[]
  /**
   * `send` goes to the agent; `original` is what was typed (shown, counted for usage).
   * `content` defaults to `send` as one text block (desktop's rule).
   */
  push: (send: string, original: string, content?: UserContentBlock[]) => Promise<void>
  remove: (id: string) => Promise<void>
  clear: () => Promise<void>
}

export function useChatQueue(tabId: string, onDrained?: (original: string) => void): ChatQueue {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const queryClient = useQueryClient()
  const list = useQuery(trpc.chat.queue.list.queryOptions({ tabId }))
  const refresh = useCallback(
    () => void queryClient.invalidateQueries(trpc.chat.queue.list.queryFilter({ tabId })),
    [queryClient, trpc, tabId]
  )
  useSubscription(
    trpc.chat.onQueueChanged.subscriptionOptions(undefined, {
      onStarted: refresh,
      onData: (msg) => {
        if (msg.tabId === tabId) refresh()
      }
    })
  )
  const onDrainedMsg = useStableCallback((msg: { tabId: string; original: string }) => {
    if (msg.tabId === tabId) onDrained?.(msg.original)
  })
  useSubscription(trpc.chat.onQueueDrained.subscriptionOptions(undefined, { onData: onDrainedMsg }))

  const push = useCallback(
    async (send: string, original: string, content?: UserContentBlock[]) => {
      // The id it gets here is the id it is sent with (the outbox tracks it by it).
      await trpcClient.chat.queue.push.mutate({
        tabId,
        send,
        original,
        id: newMessageId(),
        content: content ?? [{ type: 'text', text: send }]
      })
    },
    [trpcClient, tabId]
  )
  const remove = useCallback(
    async (id: string) => {
      await trpcClient.chat.queue.remove.mutate({ id })
    },
    [trpcClient]
  )
  const clear = useCallback(async () => {
    await trpcClient.chat.queue.clear.mutate({ tabId })
  }, [trpcClient, tabId])

  return { items: list.data ?? [], push, remove, clear }
}
