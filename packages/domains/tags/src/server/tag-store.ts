import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { recordActivityEvents } from '@slayzone/history/server'
import type { CreateTagInput, Tag, UpdateTagInput } from '../shared'
import { tagsEvents } from './events'

function buildTaskTagsChangedEvents(
  task: { id: string; project_id: string },
  previousTagIds: string[],
  nextTagIds: string[],
) {
  const previousSet = new Set(previousTagIds)
  const nextSet = new Set(nextTagIds)
  const addedTagIds = nextTagIds.filter((tagId) => !previousSet.has(tagId))
  const removedTagIds = previousTagIds.filter((tagId) => !nextSet.has(tagId))

  if (addedTagIds.length === 0 && removedTagIds.length === 0) return []

  return [{
    entityType: 'task' as const,
    entityId: task.id,
    projectId: task.project_id,
    taskId: task.id,
    kind: 'task.tags_changed' as const,
    actorType: 'user' as const,
    source: 'task' as const,
    summary: 'Tags updated',
    payload: { addedTagIds, removedTagIds },
  }]
}

export function listAllTags(db: Database): Tag[] {
  return db.prepare('SELECT * FROM tags ORDER BY sort_order, name').all() as Tag[]
}

export function createTag(db: Database, data: CreateTagInput): Tag {
  const id = randomUUID()
  const maxOrder = db
    .prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM tags WHERE project_id = ?')
    .get(data.projectId) as { m: number }
  db.prepare(
    'INSERT INTO tags (id, project_id, name, color, text_color, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    data.projectId,
    data.name,
    data.color ?? '#6366f1',
    data.textColor ?? '#ffffff',
    maxOrder.m + 1,
  )
  return db.prepare('SELECT * FROM tags WHERE id = ?').get(id) as Tag
}

export function updateTag(db: Database, data: UpdateTagInput): Tag {
  const fields: string[] = []
  const values: unknown[] = []

  if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name) }
  if (data.color !== undefined) { fields.push('color = ?'); values.push(data.color) }
  if (data.textColor !== undefined) { fields.push('text_color = ?'); values.push(data.textColor) }
  if (data.sort_order !== undefined) { fields.push('sort_order = ?'); values.push(data.sort_order) }

  if (fields.length > 0) {
    values.push(data.id)
    db.prepare(`UPDATE tags SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  }
  return db.prepare('SELECT * FROM tags WHERE id = ?').get(data.id) as Tag
}

export function deleteTag(db: Database, id: string): boolean {
  const result = db.prepare('DELETE FROM tags WHERE id = ?').run(id)
  return result.changes > 0
}

export function reorderTags(db: Database, tagIds: string[]): void {
  const stmt = db.prepare('UPDATE tags SET sort_order = ? WHERE id = ?')
  db.transaction(() => {
    for (let i = 0; i < tagIds.length; i++) stmt.run(i, tagIds[i])
  })()
}

export function getTagsForTask(db: Database, taskId: string): Tag[] {
  return db
    .prepare(
      `SELECT tags.* FROM tags
       JOIN task_tags ON tags.id = task_tags.tag_id
       WHERE task_tags.task_id = ?
       ORDER BY tags.sort_order, tags.name`,
    )
    .all(taskId) as Tag[]
}

export function getAllTaskTagIds(db: Database): Record<string, string[]> {
  const rows = db
    .prepare('SELECT task_id, tag_id FROM task_tags')
    .all() as { task_id: string; tag_id: string }[]
  const map: Record<string, string[]> = {}
  for (const row of rows) {
    if (!map[row.task_id]) map[row.task_id] = []
    map[row.task_id].push(row.tag_id)
  }
  return map
}

export function setTagsForTask(db: Database, taskId: string, tagIds: string[]): void {
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

  tagsEvents.emit('tags:set-for-task', { taskId, tagIds })
}
