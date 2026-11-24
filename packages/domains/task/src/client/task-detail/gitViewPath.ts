/**
 * The repo a task's git panel views (ephemeral: picking one here never changes the
 * task-bound path). In order: the user's pick while it is listed; the task-bound
 * folder when it is a listed repo; the first listed repo (a wrapper-folder project);
 * else the task-bound folder itself.
 *
 * A worktree is never in the project's repo list — the panel views the project's
 * repo and reads the worktree as the task's own checkout — so while that list loads,
 * a worktree task views nothing yet rather than its worktree: starting there meant
 * jumping to the project repo a round trip later, every read thrown away and redone.
 */
export function gitViewPath(opts: {
  picked: string | null
  repos: readonly { path: string }[]
  /** The repo list answered (or failed), or there is none to wait for. */
  reposSettled: boolean
  /** The worktree if the task has one, else the resolved child / project root. */
  taskBound: string | null
  hasWorktree: boolean
}): string | null {
  const { picked, repos, reposSettled, taskBound, hasWorktree } = opts
  const listed = (path: string | null) => !!path && repos.some((r) => r.path === path)
  if (listed(picked)) return picked
  if (listed(taskBound)) return taskBound
  if (repos.length > 0) return repos[0].path
  if (hasWorktree && !reposSettled) return null
  return taskBound
}
