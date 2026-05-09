import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import type { RepoEntry } from '@slayzone/worktrees/shared'

export interface UseProjectReposResult {
  repos: RepoEntry[]
  loading: boolean
  refresh: () => void
}

export function useProjectRepos(
  projectPath: string | null,
  taskBoundPath: string | null
): UseProjectReposResult {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const reposQuery = useQuery({
    ...trpc.worktrees.listProjectRepos.queryOptions({
      projectPath: projectPath ?? '',
      opts: { taskBoundPath },
    }),
    enabled: !!projectPath,
  })

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: trpc.worktrees.listProjectRepos.queryKey() })
  }, [queryClient, trpc])

  return {
    repos: reposQuery.data ?? [],
    loading: !!projectPath && reposQuery.isLoading,
    refresh,
  }
}
