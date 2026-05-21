import type { Database } from 'better-sqlite3'

export function reorderTasksOp(db: Database, taskIds: string[]): void {
  const stmt = db.prepare('UPDATE tasks SET "order" = ? WHERE id = ?')
  db.transaction(() => {
    taskIds.forEach((id, index) => {
      stmt.run(index, id)
    })
  })()
}

/**
 * Set the complete ordered list of pinned tasks: `pinned = 1` + `pin_order =
 * index` for each id. Doubles as the bulk "pin" path (passing newly-pinned ids
 * appended to the existing list). Does not touch tasks absent from the list —
 * unpinning is a separate write (mirrors `reorderTasksOp`).
 */
export function reorderPinnedTasksOp(db: Database, taskIds: string[]): void {
  const stmt = db.prepare('UPDATE tasks SET pinned = 1, pin_order = ? WHERE id = ?')
  db.transaction(() => {
    taskIds.forEach((id, index) => {
      stmt.run(index, id)
    })
  })()
}
