import type { SlayzoneDb } from '@slayzone/platform'
import { cleanupTaskFull } from './shared.js'

/**
 * Startup purge for stale soft-deleted tasks + orphaned temporary tasks.
 *
 * Extracted from the (now-dead) `registerTaskHandlers` IPC bootstrap so the
 * logic survives handler deletion and can be wired into the sidecar/host boot
 * (it currently runs nowhere in production — a regression from the Slice 9 IPC→
 * tRPC cutover, since the handler that called it is no longer registered).
 *
 * Two passes:
 *  1. Hard-delete tasks soft-deleted >5 min ago in a previous session.
 *  2. Hard-delete orphaned temporary tasks: `is_temporary`, untouched >24h, AND
 *     absent from EVERY persisted `viewState` tab list. PTY activity does NOT bump
 *     `updated_at`, so the time gate alone would purge actively-used scratch
 *     terminals after a quit/restart; cross-checking viewState spares open temp
 *     tasks, while the 24h gate still catches true orphans (crash leaks, tabs
 *     closed without renderer cleanup). A corrupt viewState protects nothing (its
 *     tasks fall back to the time-only rule), as before.
 *
 *     "Every" (T-16): the global `settings` row (a hub without login) AND each
 *     user's row in `user_settings` (a hub with login, where `viewState` is per
 *     user). Reading only the global row let one user's tabs decide which of
 *     another user's temporary tasks were deleted.
 */
export async function purgeStaleAndOrphanedTasks(db: SlayzoneDb): Promise<void> {
  // Pass 1 — stale soft-deleted tasks from previous sessions.
  const stale = (await db
    .prepare(
      `SELECT id FROM tasks WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now', '-5 minutes')`
    )
    .all()) as { id: string }[]
  const staleIds = stale.map((r) => r.id)
  for (const { id } of stale) {
    await cleanupTaskFull(db, id, staleIds)
  }
  if (stale.length > 0) {
    const placeholders = stale.map(() => '?').join(',')
    await db
      .prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`)
      .run(...stale.map((r) => r.id))
    console.log(`Purged ${stale.length} soft-deleted task(s)`)
  }

  // Pass 2 — orphaned temporary tasks (open in no persisted viewState).
  const openTaskIds = await readOpenTaskIds(db)
  const staleTemp = (
    (await db
      .prepare(
        `SELECT id FROM tasks
         WHERE is_temporary = 1
           AND deleted_at IS NULL
           AND updated_at < datetime('now', '-24 hours')`
      )
      .all()) as { id: string }[]
  ).filter(({ id }) => !openTaskIds.has(id))
  const staleTempIds = staleTemp.map((r) => r.id)
  for (const { id } of staleTemp) {
    await cleanupTaskFull(db, id, staleTempIds)
  }
  if (staleTemp.length > 0) {
    const placeholders = staleTemp.map(() => '?').join(',')
    await db
      .prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`)
      .run(...staleTemp.map((r) => r.id))
    console.log(`Purged ${staleTemp.length} stale temporary task(s)`)
  }

  // Pass 3 — reap orphaned pooled agent sessions (plans/agent-sessions.md slice
  // 4/B5). A warm-pool member is a live OS process that dies on app restart, so
  // any `pooled` row from a previous run is stale. Status-only update — never
  // touches conversation_id / origin, so resume bindings stay intact (the
  // resolver gates on origin, not status).
  const reaped = await db
    .prepare(`UPDATE agent_sessions SET status = 'dead', ended_at = ? WHERE status = 'pooled'`)
    .run(Date.now())
  if (reaped.changes > 0) {
    console.log(`Reaped ${reaped.changes} orphaned pooled agent session(s)`)
  }
}

/**
 * Task ids open in any persisted `viewState`: the global row plus every user's.
 * A row that fails to parse contributes nothing (logged); the others still count.
 * A failed read contributes nothing at all — the time-only fallback.
 */
async function readOpenTaskIds(db: SlayzoneDb): Promise<Set<string>> {
  const openTaskIds = new Set<string>()
  let rows: { value: string }[]
  try {
    rows = (await db
      .prepare(
        `SELECT value FROM settings WHERE key = 'viewState'
         UNION ALL
         SELECT value FROM user_settings WHERE key = 'viewState'`
      )
      .all()) as { value: string }[]
  } catch (err) {
    console.warn(
      '[task] Failed to read viewState for temp-task cleanup; falling back to time-only purge:',
      err
    )
    return openTaskIds
  }
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.value) as { tabs?: Array<{ type?: string; taskId?: string }> }
      for (const tab of parsed.tabs ?? []) {
        if (tab?.type === 'task' && typeof tab.taskId === 'string') openTaskIds.add(tab.taskId)
      }
    } catch (err) {
      console.warn('[task] Unreadable viewState ignored by temp-task cleanup:', err)
    }
  }
  return openTaskIds
}
