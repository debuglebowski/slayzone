import { useQuery } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import type { DetectedRepo } from '@slayzone/projects/shared'

export function useDetectedRepos(projectPath: string | null): DetectedRepo[] {
  const trpc = useTRPC()
  const reposQuery = useQuery({
    ...trpc.worktrees.detectChildRepos.queryOptions({ projectPath: projectPath ?? '' }),
    enabled: !!projectPath,
  })
  return reposQuery.data ?? []
}
