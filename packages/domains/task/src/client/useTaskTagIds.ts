import { useEffect, useState } from 'react'
import { useSubscription } from '@trpc/tanstack-react-query'
import { useTRPC, useTRPCClient } from '@slayzone/transport/client'

export interface UseTaskTagIdsReturn {
  tagIds: string[]
  setTagIds: (ids: string[]) => void
}

export function useTaskTagIds(
  taskId: string | null | undefined,
  initialTagIds?: string[]
): UseTaskTagIdsReturn {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const [tagIds, setTagIds] = useState<string[]>(initialTagIds ?? [])

  // Re-fetch tag associations on external changes (CLI, MCP)
  useSubscription(
    trpc.task.onChanged.subscriptionOptions(undefined, {
      enabled: !!taskId,
      onData: () => {
        if (!taskId) return
        trpcClient.tags.getForTask.query({ taskId })
          .then(tags => setTagIds(tags.map(t => t.id)))
          .catch(() => {})
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
