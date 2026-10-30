// What the `tags` router needs from its host, injected so this domain never imports
// the notify bus. api wires it (`api/src/domain-router-deps.ts`), like every other
// domain router's host seam.

export type TagsRouterDeps = {
  /**
   * Tell every client these tasks changed — `notify.onTasksChanged` naming them, the
   * signal clients patch board rows and per-task queries on.
   */
  onTasksChanged: (taskIds: readonly string[]) => void
  /**
   * Tell every client to reload the whole board — `notify.onTasksChanged` naming no
   * tasks. For a change to a project's tags themselves (create, rename, recolour,
   * reorder, delete): they show on every card, filter and picker.
   */
  onBoardChanged: () => void
}

let deps: TagsRouterDeps | null = null

export function setTagsRouterDeps(next: TagsRouterDeps): void {
  deps = next
}

/** Best-effort: a host that wired nothing (a bare router in a unit test) tells no one. */
export function signalTasksChanged(taskIds: readonly string[]): void {
  if (taskIds.length > 0) deps?.onTasksChanged(taskIds)
}

/** Best-effort, like `signalTasksChanged`. */
export function signalBoardChanged(): void {
  deps?.onBoardChanged()
}
