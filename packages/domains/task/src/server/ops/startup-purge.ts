import type { SlayzoneDb } from '@slayzone/platform'
import { cleanupTaskFull } from './shared.js'

/** Reap expired Trash entries and pooled agent sessions at startup.
 * Scratch terminals are persistent: age and client tab state never imply deletion.
 * Explicitly deleted tasks retain their files and records for 30 days.
 */
export async function purgeStaleAndOrphanedTasks(db: SlayzoneDb): Promise<void> {
  // Pass 1 — stale soft-deleted tasks from previous sessions.
  const stale = (await db
    .prepare(
      `SELECT id FROM tasks WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now', '-30 days')`
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

  // Reap orphaned pooled agent sessions (plans/agent-sessions.md slice
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
