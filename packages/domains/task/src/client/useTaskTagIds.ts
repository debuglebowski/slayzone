import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useSubscription } from '@trpc/tanstack-react-query'
import { useTRPC } from '@slayzone/transport/client'

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

  // Re-fetch tag associations on external changes (CLI, MCP)
  useSubscription(
    trpc.task.onChanged.subscriptionOptions(undefined, {
      enabled: !!taskId,
      onData: async () => {
        if (!taskId) return
        try {
          const tags = await queryClient.fetchQuery(trpc.tags.getForTask.queryOptions({ taskId }))
          setTagIds(tags.map(t => t.id))
        } catch { /* ignore */ }
      },
    }),
  )

  // Reset to initial whenever the taskId changes (parent passed new initialTagIds).
  useEffect(() => {
    if (initialTagIds) setTagIds(initialTagIds)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId])

  return { tagIds, setTagIds }
}
