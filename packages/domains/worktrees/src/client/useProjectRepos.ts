/**
 * React hook around the `worktrees.listProjectRepos` tRPC query.
 *
 * Returns the flat list of git repos a task may want to view (project root, child repos,
 * recursive submodules), the entry at `taskBoundPath` flagged `isTaskBound` — so the UI
 * can highlight the repo that owns the task's worktree.
 *
 * The list is the project's: fetched by project only, and flagged here. Keyed by the
 * task's path too, it was fetched afresh when that path arrived (a worktree task's,
 * from its computer) — no list for one more round trip, and the git panel jumped to
 * the worktree and back meanwhile.
 *
 * NOT a viewing-state owner — that lives in the consumer (e.g. TaskDetailPage's
 * `gitViewRepoPath`). This hook is purely a data source.
 */
import { useCallback, useMemo } from 'react'
import { skipToken, useQuery } from '@tanstack/react-query'
import { useTRPC } from './trpc'
import type { RepoEntry } from '@slayzone/worktrees/shared'

export interface UseProjectReposResult {
  repos: RepoEntry[]
  loading: boolean
  /** The list has answered (or failed), or there is no project to list. */
  settled: boolean
  refresh: () => void
}

const NO_REPOS: RepoEntry[] = []

export function useProjectRepos(
  projectPath: string | null,
  taskBoundPath: string | null,
  /** Routes the scan to the machine that owns the project. */
  projectId?: string
): UseProjectReposResult {
  const trpc = useTRPC()
  const listed = !!projectPath && !!projectId
  const query = useQuery(
    // No project → no scope to name: nothing to scan (the hub would refuse it).
    trpc.worktrees.listProjectRepos.queryOptions(
      projectPath && projectId ? { projectPath, projectId } : skipToken
    )
  )

  const refresh = useCallback(() => {
    void query.refetch()
  }, [query])

  const data = query.data ?? NO_REPOS
  const repos = useMemo(
    () =>
      data.map((r) =>
        r.isTaskBound === (r.path === taskBoundPath)
          ? r
          : { ...r, isTaskBound: r.path === taskBoundPath }
      ),
    [data, taskBoundPath]
  )

  return {
    repos,
    loading: query.isFetching,
    settled: !listed || query.status !== 'pending',
    refresh
  }
}
