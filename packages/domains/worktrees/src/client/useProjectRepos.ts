/**
 * React hook around the `worktrees.listProjectRepos` tRPC query.
 *
 * Returns the flat list of git repos a task may want to view (project root, child repos,
 * recursive submodules). The `taskBoundPath` argument flips the `isTaskBound` flag on the
 * matching entry — so the UI can highlight the repo that owns the task's worktree without
 * issuing a second call.
 *
 * NOT a viewing-state owner — that lives in the consumer (e.g. TaskDetailPage's
 * `gitViewRepoPath`). This hook is purely a data source.
 */
import { useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
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
  const query = useQuery(
    trpc.worktrees.listProjectRepos.queryOptions(
      { projectPath: projectPath ?? '', opts: { taskBoundPath } },
      { enabled: !!projectPath }
    )
  )

  const refresh = useCallback(() => {
    void query.refetch()
  }, [query])

  return {
    repos: query.data ?? [],
    loading: query.isFetching,
    refresh
  }
}
