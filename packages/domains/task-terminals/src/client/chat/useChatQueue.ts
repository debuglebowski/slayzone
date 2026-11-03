import { useCallback, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useHubId, useSubscription } from '@slayzone/transport/client'
import { useTRPC, useTRPCClient } from '../trpc'
import { safeRandomUUID, useStableCallback } from '@slayzone/ui'
import type { QueuedChatMessage, UserContentBlock } from '@slayzone/terminal-contracts'
import {
  useQueuedSubmissions,
  type QueuedSubmission,
  type StagedSubmission
} from './queued-submissions'
import { createQueuedSubmissionJournal } from './composer-state/queued-submission-journal'

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
 * The list itself is the hub's (no optimistic edit of it): the server broadcasts
 * `onQueueChanged` post-mutation and the subscription invalidates the list
 * query. A push shows at once anyway: it is saved on this device first and
 * listed as `pending` (an unconfirmed row) until the hub's list has it.
 */
export interface UseChatQueueResult {
  items: QueuedChatMessage[]
  pending: QueuedSubmission[]
  retryPending: (id: string) => Promise<void>
  dismissPending: (id: string) => Promise<void>
  /**
   * `content` defaults to `send` as one text block. Resolves once saved on this
   * device, with the row's id and its delivery to the hub.
   */
  push: (send: string, original: string, content?: UserContentBlock[]) => Promise<StagedSubmission>
  remove: (id: string) => Promise<void>
  clear: () => Promise<void>
  /** Rewrite a queued message; false when it was already sent. */
  update: (
    id: string,
    send: string,
    original: string,
    content: UserContentBlock[]
  ) => Promise<boolean>
  move: (id: string, toIndex: number) => Promise<void>
  /** Hold it while edited (renew while the editor is open); false when already sent. */
  hold: (id: string) => Promise<boolean>
  release: (id: string) => Promise<void>
  /** "Send now" (`chat.queue.steer`); `ok: false` + why when the agent can't take it. */
  steer: (id: string) => Promise<{ ok: true } | { ok: false; reason: string }>
}

export function useChatQueue(
  tabId: string,
  onDrained?: (original: string) => void,
  expectedMode?: string
): UseChatQueueResult {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const queryClient = useQueryClient()
  const hubId = useHubId() ?? 'local'
  const storage = useMemo(() => createQueuedSubmissionJournal(hubId, tabId), [hubId, tabId])

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

  // Always invokes the latest `onDrained` without re-subscribing.
  const handleDrained = useStableCallback((original: string) => onDrained?.(original))
  useSubscription(
    trpc.chat.onQueueDrained.subscriptionOptions(undefined, {
      enabled: !!tabId,
      onData: ({ tabId: drainedTabId, original }) => {
        if (drainedTabId === tabId) handleDrained(original)
      }
    })
  )

  // Fire-and-forget RPC facade via the STABLE vanilla client. (useMutation
  // returns a new object each render; wrapping it in these callbacks made them
  // unstable, and a consumer effect keyed on `clear` looped infinitely.)
  // Stable (the store is rebuilt when `deliver` changes). A refresh that fails
  // changes nothing: the hub has the message.
  const refreshList = useStableCallback(() =>
    Promise.resolve()
      .then(() => queryClient.invalidateQueries(trpc.chat.queue.list.queryFilter({ tabId })))
      .catch(() => undefined)
  )
  const deliver = useCallback(
    async ({ id, send, original, content, expectedMode }: QueuedSubmission) => {
      // The id it gets here is the id it is sent with: the outbox tracks the
      // drained message under it. Content travels as blocks, like a direct send.
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
  const submissions = useQueuedSubmissions({ storage, deliver, createId: safeRandomUUID })
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
      await trpcClient.chat.queue.remove.mutate({ id })
    },
    [trpcClient]
  )

  const clear = useCallback(async () => {
    await trpcClient.chat.queue.clear.mutate({ tabId })
  }, [trpcClient, tabId])

  const update = useCallback(
    (id: string, send: string, original: string, content: UserContentBlock[]) =>
      trpcClient.chat.queue.update.mutate({ id, send, original, content }),
    [trpcClient]
  )
  const move = useCallback(
    async (id: string, toIndex: number) => {
      await trpcClient.chat.queue.move.mutate({ id, toIndex })
    },
    [trpcClient]
  )
  const hold = useCallback((id: string) => trpcClient.chat.queue.hold.mutate({ id }), [trpcClient])
  const release = useCallback(
    async (id: string) => {
      await trpcClient.chat.queue.release.mutate({ id })
    },
    [trpcClient]
  )

  const steer = useCallback(
    (id: string) => trpcClient.chat.queue.steer.mutate({ id }),
    [trpcClient]
  )

  return {
    items: listQuery.data ?? [],
    pending: submissions.pending,
    retryPending: submissions.retry,
    dismissPending: submissions.dismiss,
    push,
    remove,
    clear,
    update,
    move,
    hold,
    release,
    steer
  }
}
