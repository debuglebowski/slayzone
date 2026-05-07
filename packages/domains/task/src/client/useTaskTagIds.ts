import { useState, useEffect } from 'react'
import { getTrpcVanillaClient } from '@slayzone/transport/client'

export interface UseTaskTagIdsReturn {
  tagIds: string[]
  setTagIds: (ids: string[]) => void
}

export function useTaskTagIds(
  taskId: string | null | undefined,
  initialTagIds?: string[]
): UseTaskTagIdsReturn {
  const [tagIds, setTagIds] = useState<string[]>(initialTagIds ?? [])

  // Re-fetch tag associations on external changes (CLI, MCP)
  useEffect(() => {
    if (!taskId) return
    const refresh = (): void => {
      getTrpcVanillaClient()
        .tags.getForTask.query({ taskId })
        .then(tags => setTagIds(tags.map(t => t.id)))
        .catch(() => {})
    }
    const cleanup = window.api?.app?.onTasksChanged?.(refresh)
    return () => { cleanup?.() }
  }, [taskId])

  return { tagIds, setTagIds }
}
