import { skipToken, useQuery } from '@tanstack/react-query'
import { useTRPC } from './trpc'
import type { DetectedRepo } from '@slayzone/projects-contracts'

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
    // No project → no scope to name: nothing to scan (the hub would refuse it).
    trpc.worktrees.detectChildRepos.queryOptions(
      projectPath && projectId ? { projectPath, projectId } : skipToken
    )
  )
  return projectPath && projectId ? (query.data ?? []) : []
}
