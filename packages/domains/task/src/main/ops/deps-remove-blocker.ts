import type { Database } from 'better-sqlite3'

export function removeBlockerOp(db: Database, taskId: string, blockerTaskId: string): void {
  db.prepare(
    'DELETE FROM task_dependencies WHERE task_id = ? AND blocks_task_id = ?'
  ).run(blockerTaskId, taskId)
}
