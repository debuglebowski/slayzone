/**
 * The tab's "Up next" queue: messages sent while a turn runs, kept by the hub (table
 * `chat_queue`) and sent by it, in order, when the agent is free. This hook only reads
 * it (`chat.queue.list`, reloaded on `chat.onQueueChanged` and whenever that
 * subscription (re)starts — a reconnect may have missed changes) and asks for changes.
 * Desktop's counterpart: `task-terminals/src/client/chat/useChatQueue.ts`.
 */
import type { QueuedChatMessage, UserContentBlock } from '@slayzone/terminal-contracts'
import { useHubId, useSubscription } from '@slayzone/transport/client'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import { newMessageId } from './ids'
import { useTRPC, useTRPCClient } from '../trpc'
import { useStableCallback } from './useStableCallback'
import {
  useQueuedSubmissions,
  type QueuedSubmission,
  type StagedSubmission
} from '@slayzone/task-terminals/queued-submissions'
import { createQueuedSubmissionJournal } from './queued-submission-journal'

export interface ChatQueue {
  items: QueuedChatMessage[]
  pending?: QueuedSubmission[]
  retryPending?: (id: string) => Promise<void>
  dismissPending?: (id: string) => Promise<void>
  /**
   * `send` goes to the agent; `original` is what was typed (shown, counted for usage).
   * `content` defaults to `send` as one text block (desktop's rule).
   */
  push: (send: string, original: string, content?: UserContentBlock[]) => Promise<StagedSubmission>
  remove: (id: string) => Promise<void>
  clear: () => Promise<void>
  /** "Send now" (`chat.queue.steer`); `ok: false` + why when the agent can't take it. */
  steer: (id: string) => Promise<{ ok: true } | { ok: false; reason: string }>
}

export function useChatQueue(
  tabId: string,
  onDrained?: (original: string) => void,
  expectedMode?: string
): ChatQueue {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const queryClient = useQueryClient()
  const hubId = useHubId() ?? 'local'
  const storage = useMemo(() => createQueuedSubmissionJournal(hubId, tabId), [hubId, tabId])
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

  // Stable (the store is rebuilt when `deliver` changes). A refresh that fails
  // changes nothing: the hub has the message.
  const refreshList = useStableCallback(() =>
    Promise.resolve()
      .then(() => queryClient.invalidateQueries(trpc.chat.queue.list.queryFilter({ tabId })))
      .catch(() => undefined)
  )
  const deliver = useCallback(
    async ({ id, send, original, content, expectedMode }: QueuedSubmission) => {
      // The id it gets here is the id it is sent with (the outbox tracks it by it).
      await trpcClient.chat.queue.push.mutate({
        tabId,
        send,
        original,
        id,
        content,
        ...(expectedMode ? { expectedMode } : {})
      })
      // Its local row gives way to the hub's only once the list has it: no gap.
      await refreshList()
    },
    [trpcClient, tabId, refreshList]
  )
  const submissions = useQueuedSubmissions({ storage, deliver, createId: newMessageId })
  // Resolves once saved on this device: the row shows (and the draft clears) at
  // once; a delivery that fails later shows on the row, with Retry.
  const { stage: pushSubmission } = submissions
  const push = useCallback(
    (send: string, original: string, content?: UserContentBlock[]) =>
      pushSubmission({
        send,
        original,
        content: content ?? [{ type: 'text', text: send }],
        ...(expectedMode ? { expectedMode } : {})
      }),
    [pushSubmission, expectedMode]
  )
  const remove = useCallback(
    async (id: string) => {
      await trpcClient.chat.queue.remove.mutate({ id, tabId })
    },
    [trpcClient, tabId]
  )
  const clear = useCallback(async () => {
    await trpcClient.chat.queue.clear.mutate({ tabId })
  }, [trpcClient, tabId])

  const steer = useCallback(
    (id: string) => trpcClient.chat.queue.steer.mutate({ id, tabId }),
    [trpcClient, tabId]
  )

  return {
    items: list.data ?? [],
    pending: submissions.pending,
    retryPending: submissions.retry,
    dismissPending: submissions.dismiss,
    push,
    remove,
    clear,
    steer
  }
}
