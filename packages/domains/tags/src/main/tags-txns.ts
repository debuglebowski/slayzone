import type { Database } from 'better-sqlite3'
import { recordActivityEvents, type RecordActivityEventInput } from '@slayzone/history/recorder'

/**
 * Named-transaction adapters for the tags domain. `setForTask` is a conditional
 * read-modify-write (read previous tag_ids, delete + re-insert, then read the
 * task row and conditionally record activity events) that can't be expressed as
 * a static op list — it must run as a single function inside the DB worker.
 * Registered into the worker's txn registry via `@slayzone/tags/db`. This owns
 * its own `db.transaction(...)`, so the worker does NOT re-wrap it.
 *
 * Pure: imports only better-sqlite3 + the pure `recorder` module + shared types,
 * so it is safe to pull into the worker bundle (unlike the electron-laden
 * `/main` barrel).
 */

function buildTaskTagsChangedEvents(
  task: { id: string; project_id: string },
  previousTagIds: string[],
  nextTagIds: string[]
): RecordActivityEventInput[] {
  const previousSet = new Set(previousTagIds)
  const nextSet = new Set(nextTagIds)
  const addedTagIds = nextTagIds.filter((tagId) => !previousSet.has(tagId))
  const removedTagIds = previousTagIds.filter((tagId) => !nextSet.has(tagId))

  if (addedTagIds.length === 0 && removedTagIds.length === 0) return []

  return [
    {
      entityType: 'task' as const,
      entityId: task.id,
      projectId: task.project_id,
      taskId: task.id,
      kind: 'task.tags_changed' as const,
      actorType: 'user' as const,
      source: 'task' as const,
      summary: 'Tags updated',
      payload: { addedTagIds, removedTagIds }
    }
  ]
}

function setTagsForTask(db: Database, taskId: string, tagIds: string[]): void {
  const deleteStmt = db.prepare('DELETE FROM task_tags WHERE task_id = ?')
  const insertStmt = db.prepare('INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)')
  db.transaction(() => {
    const previousRows = db
      .prepare('SELECT tag_id FROM task_tags WHERE task_id = ? ORDER BY tag_id ASC')
      .all(taskId) as Array<{ tag_id: string }>
    const previousTagIds = previousRows.map((row) => row.tag_id)
    deleteStmt.run(taskId)
    for (const tagId of tagIds) insertStmt.run(taskId, tagId)

    const taskRow = db
      .prepare('SELECT id, project_id FROM tasks WHERE id = ?')
      .get(taskId) as { id: string; project_id: string } | undefined
    if (taskRow) {
      recordActivityEvents(db, buildTaskTagsChangedEvents(taskRow, previousTagIds, tagIds))
    }
  })()
}

export const tagsTxns = {
  'tags:setForTask': (db: Database, p: { taskId: string; tagIds: string[] }) => {
    setTagsForTask(db, p.taskId, p.tagIds)
    return null
  }
} satisfies Record<string, (db: Database, params: never) => unknown>
