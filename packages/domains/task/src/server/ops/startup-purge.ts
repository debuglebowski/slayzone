import type { SlayzoneDb } from '@slayzone/platform'

/** Reap processes lost on restart. Content lifetime never depends on its age. */
export async function purgeStaleAndOrphanedTasks(db: SlayzoneDb): Promise<void> {
  const reaped = await db
    .prepare("UPDATE agent_sessions SET status = 'dead', ended_at = ? WHERE status = 'pooled'")
    .run(Date.now())
  if (reaped.changes > 0) console.log(`Reaped ${reaped.changes} orphaned pooled agent session(s)`)
}
