import { useCallback, useEffect, useRef, useState } from 'react'
import type { QueuedChatMessage } from '@slayzone/terminal/shared'

/**
 * Subscribe to the backend-persisted chat queue for one tab. The queue is
 * a single source of truth in SQLite (table `chat_queue`); this hook is
 * purely a subscriber + thin RPC facade.
 *
 * Fetches initial state on mount + on `tabId` change, refetches on
 * `chat:queue-changed` broadcasts (push, remove, clear, drain). The drain
 * callback is exposed separately so the consumer can bump autocomplete
 * usage counts with the raw `original` token after a drain dispatches.
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
    const list = await window.api.chatQueue.list(tabId)
    setItems(list)
  }, [tabId])

  useEffect(() => {
    void refetch()
    const off = window.api.chatQueue.onChanged((changedTabId) => {
      if (changedTabId === tabId) void refetch()
    })
    return off
  }, [tabId, refetch])

  const onDrainedRef = useRef(onDrained)
  useEffect(() => {
    onDrainedRef.current = onDrained
  })
  useEffect(() => {
    const off = window.api.chatQueue.onDrained((drainedTabId, original) => {
      if (drainedTabId === tabId) onDrainedRef.current?.(original)
    })
    return off
  }, [tabId])

  const push = useCallback(
    async (send: string, original: string) => {
      await window.api.chatQueue.push(tabId, send, original)
      // No optimistic update — onChanged fires post-insert and triggers refetch.
    },
    [tabId]
  )

  const remove = useCallback(async (id: string) => {
    await window.api.chatQueue.remove(id)
  }, [])

  const clear = useCallback(async () => {
    await window.api.chatQueue.clear(tabId)
  }, [tabId])

  return { items, push, remove, clear }
}
