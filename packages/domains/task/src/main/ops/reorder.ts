import type { Database } from 'better-sqlite3'

export function reorderTasksOp(db: Database, taskIds: string[]): void {
  const stmt = db.prepare('UPDATE tasks SET "order" = ? WHERE id = ?')
  db.transaction(() => {
    taskIds.forEach((id, index) => {
      stmt.run(index, id)
    })
  })()
}
