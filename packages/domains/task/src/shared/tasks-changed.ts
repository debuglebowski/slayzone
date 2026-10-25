/**
 * The `tasks-changed` refresh signal.
 *
 * A writer that knows EXACTLY which task rows it touched — and touched nothing
 * else the board shows (no other task's row, no tag definitions, projects or
 * groups) — names them in `taskIds`. The named rows themselves may be new, moved,
 * deleted, retagged or (un)blocked: the renderer patches just those rows
 * (`task.loadBoardRows`, which places a new or moved row before its board
 * successor) instead of reloading the whole board. Any writer that cannot vouch for that omits the
 * change, which means "anything may have changed": full reload. Omitting is
 * always safe; naming ids is a promise.
 */
export interface TasksChange {
  taskIds: readonly string[]
}

/**
 * What `notify.onTasksChanged` delivers. `taskIds: null` = unknown scope (full
 * reload). Bursts are coalesced server-side, so one event can carry the union
 * of several changes. Hubs that predate the payload send nothing at all —
 * consumers must read `undefined` as `null`.
 */
export interface TasksChangedEvent {
  taskIds: string[] | null
}
