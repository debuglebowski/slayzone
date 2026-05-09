/**
 * React hook around the `git:listProjectRepos` IPC.
 *
 * Returns the flat list of git repos a task may want to view (project root, child repos,
 * recursive submodules). The `taskBoundPath` argument flips the `isTaskBound` flag on the
 * matching entry — so the UI can highlight the repo that owns the task's worktree without
 * issuing a second IPC.
 *
 * NOT a viewing-state owner — that lives in the consumer (e.g. TaskDetailPage's
 * `gitViewRepoPath`). This hook is purely a data source.
 */
import { useEffect, useState, useCallback } from 'react'
import { useTRPCClient } from '@slayzone/transport/client'
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
  const trpcClient = useTRPCClient()
  const [repos, setRepos] = useState<RepoEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [version, setVersion] = useState(0)

  const refresh = useCallback(() => setVersion(v => v + 1), [])

  useEffect(() => {
    if (!projectPath) { setRepos([]); return }
    let cancelled = false
    setLoading(true)
    trpcClient.worktrees.listProjectRepos.query({ projectPath: projectPath, opts: { taskBoundPath } })
      .then(list => { if (!cancelled) setRepos(list) })
      .catch(() => { if (!cancelled) setRepos([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [projectPath, taskBoundPath, version, trpcClient])

  return { repos, loading, refresh }
}
