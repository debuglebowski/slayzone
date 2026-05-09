import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'

/**
 * Polls the stale-skill count for the active project.
 * Event-driven: mount, project change, window focus, manual refresh.
 */
export function useStaleSkillCount(
  projectId: string | null | undefined,
  projectPath: string | null | undefined
): { count: number; refresh: () => void } {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const enabled = !!projectId && !!projectPath
  const { data: count = 0 } = useQuery({
    ...trpc.aiConfig.getProjectStaleSkillCount.queryOptions(
      { projectId: projectId ?? '', projectPath: projectPath ?? '' },
      { enabled },
    ),
  })

  const refresh = () => {
    if (!enabled) return
    queryClient.invalidateQueries({
      queryKey: trpc.aiConfig.getProjectStaleSkillCount.queryKey({ projectId: projectId!, projectPath: projectPath! }),
    })
  }

  useEffect(() => {
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, projectPath])

  return { count, refresh }
}
