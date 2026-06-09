import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTRPC, useSubscription } from '@slayzone/transport/client'

export interface UseTaskTagIdsReturn {
  tagIds: string[]
  setTagIds: (ids: string[]) => void
}

export function useTaskTagIds(
  taskId: string | null | undefined,
  initialTagIds?: string[]
): UseTaskTagIdsReturn {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [tagIds, setTagIds] = useState<string[]>(initialTagIds ?? [])

  // Re-fetch tag associations on external changes (CLI, MCP). Mirrors the legacy
  // `app.onTasksChanged` IPC listener via the `tasks-changed` subscription.
  useSubscription(
    trpc.notify.onTasksChanged.subscriptionOptions(undefined, {
      enabled: !!taskId,
      onData: () => {
        if (!taskId) return
        void queryClient
          .fetchQuery(trpc.tags.getForTask.queryOptions({ taskId }))
          .then((tags) => setTagIds(tags.map((t) => t.id)))
          .catch(() => {})
      }
    })
  )

  return { tagIds, setTagIds }
}
