import { useCallback, useMemo } from 'react'
import { defaultProjectRoot, resolveRepoPath, type Project } from '@slayzone/projects-contracts'
import { useProjectRepos } from '@slayzone/worktrees/hooks'
import { useTRPCClient } from './trpc'

/**
 * The Home git panel's repos: the selected project's root + child repos + recursive
 * submodules (same source as the task git panel), the one it resolves to, and the
 * repo picker's save.
 *
 * Called by HomeDetail itself, so it runs INSIDE the Home view's hub scope (the hub
 * that owns the selected project). The app shell used to compute this above that
 * scope, on the default hub's client — for another hub's project the default hub
 * does not know, which sent its folder to this machine's computer (refused).
 */
export function useHomeRepos(
  project: Project | null | undefined,
  updateProject: (project: Project) => void
) {
  const trpcClient = useTRPCClient()
  const { repos } = useProjectRepos(defaultProjectRoot(project), null, project?.id)
  const homeDetectedRepos = useMemo(
    () => repos.map((r) => ({ name: r.name, path: r.path, kind: r.kind })),
    [repos]
  )
  const homeResolvedRepo = useMemo(
    () =>
      resolveRepoPath(
        defaultProjectRoot(project),
        homeDetectedRepos,
        project?.selected_repo ?? null
      ),
    [project, homeDetectedRepos]
  )
  const projectId = project?.id
  const handleHomeRepoChange = useCallback(
    (repoName: string) => {
      if (!projectId) return
      void trpcClient.projects.update
        .mutate({ id: projectId, selectedRepo: repoName })
        .then((updated) => updateProject(updated as Project))
    },
    [projectId, trpcClient, updateProject]
  )
  return { homeDetectedRepos, homeResolvedRepo, handleHomeRepoChange }
}
