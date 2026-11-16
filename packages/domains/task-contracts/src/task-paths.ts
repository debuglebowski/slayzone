/**
 * A task's computer paths — its worktree and its custom working folder — as a client
 * reads them (robustness plan §9, P0; Phase 7d). They live only on the computer
 * holding the task's work; the hub relays one read (`task.paths`) and keeps no copy.
 * With that computer not connected the answer is `offline` (the UI then shows the
 * task as "on <computer>"), never an error and never a stale hub value.
 */
export type TaskPathState =
  | { state: 'ok'; worktreePath: string | null; baseDir: string | null }
  | {
      state: 'offline'
      /** The computer holding the paths; null when the task has none yet. */
      computerId: string | null
    }

/** Most task ids one `task.paths` read may name. */
export const TASK_PATHS_MAX = 500

/**
 * The folder a task's work is bound to before the project folder: its worktree,
 * else its custom working folder. Null while unknown (loading/offline) or unset.
 */
export function taskOwnFolder(paths: TaskPathState | null | undefined): string | null {
  if (!paths || paths.state !== 'ok') return null
  return paths.worktreePath ?? paths.baseDir ?? null
}
