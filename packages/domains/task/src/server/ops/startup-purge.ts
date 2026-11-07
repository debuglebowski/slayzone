import type { SlayzoneDb } from '@slayzone/platform'
import { cleanupTaskFull, getRuntimeAdapters } from './shared.js'

/** Reap expired Trash entries and pooled agent sessions at startup.
 * Scratch terminals are persistent: age and client tab state never imply deletion.
 * Explicitly deleted tasks retain their files and records for 30 days.
 */
export async function purgeStaleAndOrphanedTasks(db: SlayzoneDb): Promise<void> {
  // Pass 1 — stale soft-deleted tasks from previous sessions.
  await purgeExpiredTrash(db)

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

let running: Promise<void> | null = null
let again = false

/**
 * Delete the tasks that have been in the Trash for over 30 days — each only once its
 * worktree is gone from the computer that holds it (final review round 5, R5-1). At
 * boot no computer is connected yet: such a task stays, and the hub calls this again
 * when a computer connects. A computer that is gone for good (deleted, revoked) never
 * blocks: the task goes, and the worktree it held is reported as left behind. A
 * removal the computer itself fails (git refused) does not block either — as before.
 *
 * Serialized: a call while one runs makes it run once more afterwards, never twice
 * at once (two computers connecting together).
 */
export function purgeExpiredTrash(db: SlayzoneDb): Promise<void> {
  if (running) {
    again = true
    return running
  }
  running = (async () => {
    do {
      again = false
      await purgeExpiredTrashOnce(db)
    } while (again)
  })().finally(() => {
    running = null
  })
  return running
}

async function purgeExpiredTrashOnce(db: SlayzoneDb): Promise<void> {
  const adapters = getRuntimeAdapters()
  const stale = (await db
    .prepare(
      `SELECT id, project_id, worktree_path FROM tasks
        WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now', '-30 days')`
    )
    .all()) as { id: string; project_id: string; worktree_path: string | null }[]
  const staleIds = stale.map((r) => r.id)
  const purged: string[] = []
  let waiting = 0
  for (const task of stale) {
    if (!task.worktree_path) {
      await cleanupTaskFull(db, task.id, staleIds)
      purged.push(task.id)
      continue
    }
    const state = await adapters.worktreeComputerState(task.id)
    if (state === 'wait') {
      waiting++
      continue
    }
    if (state === 'gone') {
      await cleanupTaskFull(db, task.id, staleIds, { skipWorktree: true })
      adapters.recordDiagnosticEvent({
        level: 'warn',
        source: 'task',
        event: 'task.purge_worktree_left_behind',
        taskId: task.id,
        projectId: task.project_id,
        message: `The computer that held ${task.worktree_path} is gone; the worktree stays on it.`
      })
      purged.push(task.id)
      continue
    }
    const outcome = await cleanupTaskFull(db, task.id, staleIds)
    // The computer went away while the removal was in flight: try again later.
    if (outcome === 'failed' && (await adapters.worktreeComputerState(task.id)) === 'wait') {
      waiting++
      continue
    }
    purged.push(task.id)
  }
  if (purged.length > 0) {
    const placeholders = purged.map(() => '?').join(',')
    await db.prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`).run(...purged)
    console.log(`Purged ${purged.length} soft-deleted task(s)`)
  }
  if (waiting > 0) {
    console.log(`Kept ${waiting} expired task(s) until their computer connects`)
  }
}
