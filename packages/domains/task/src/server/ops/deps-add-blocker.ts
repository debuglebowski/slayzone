import type { Database } from 'better-sqlite3'

export function addBlockerOp(db: Database, taskId: string, blockerTaskId: string): void {
  db.prepare(
    'INSERT OR IGNORE INTO task_dependencies (task_id, blocks_task_id) VALUES (?, ?)'
  ).run(blockerTaskId, taskId)
}
