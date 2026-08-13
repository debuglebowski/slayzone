import { useQuery } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import type { DetectedRepo } from '@slayzone/projects/shared'

/**
 * Child git repos of a project directory, discovered on the machine that owns it.
 *
 * `projectId` is what routes the scan to that machine. Without it the hub would
 * scan its own disk, and a multi-repo project on a computer would resolve to the
 * wrong terminal cwd (or to none at all).
 */
export function useDetectedRepos(projectPath: string | null, projectId?: string): DetectedRepo[] {
  const trpc = useTRPC()
  const query = useQuery(
    trpc.worktrees.detectChildRepos.queryOptions(
      { projectPath: projectPath ?? '', projectId },
      { enabled: !!projectPath }
    )
  )
  return projectPath ? (query.data ?? []) : []
}
