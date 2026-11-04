// What the `artifacts` router needs from its host, injected so this domain never
// imports `@slayzone/api` (wired at load by `api/src/domain-router-deps.ts`).

export type ArtifactsRouterDeps = {
  /**
   * Tell every client these tasks' artifacts changed — `notify.onTasksChanged`
   * naming them, the signal clients refresh `artifacts.getByTask` and
   * `artifacts.foldersGetByTask` on (a task's per-task queries).
   */
  onTasksChanged: (taskIds: readonly string[]) => void
}

let deps: ArtifactsRouterDeps | null = null

export function setArtifactsRouterDeps(next: ArtifactsRouterDeps): void {
  deps = next
}

export function getArtifactsRouterDeps(): ArtifactsRouterDeps {
  if (!deps)
    throw new Error(
      'artifacts router deps not initialized — @slayzone/api wires them when it composes the router'
    )
  return deps
}

/**
 * Best-effort: a write must not fail because nobody is told
 * (a bare router in a unit test wires no host).
 */
export function signalTasksChanged(taskIds: Iterable<string | null | undefined>): void {
  const ids = [...new Set([...taskIds].filter((id): id is string => !!id))]
  if (ids.length > 0) deps?.onTasksChanged(ids)
}
