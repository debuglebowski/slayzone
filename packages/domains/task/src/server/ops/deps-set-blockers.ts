import type { Database } from 'better-sqlite3'

export function setBlockersOp(db: Database, taskId: string, blockerTaskIds: string[]): void {
  const deleteStmt = db.prepare('DELETE FROM task_dependencies WHERE blocks_task_id = ?')
  const insertStmt = db.prepare(
    'INSERT INTO task_dependencies (task_id, blocks_task_id) VALUES (?, ?)'
  )

  db.transaction(() => {
    deleteStmt.run(taskId)
    for (const blockerTaskId of blockerTaskIds) {
      insertStmt.run(blockerTaskId, taskId)
    }
  })()
}
