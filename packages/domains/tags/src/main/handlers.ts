import type { IpcMain } from 'electron'
import type { Database } from 'better-sqlite3'
import type { CreateTagInput, UpdateTagInput } from '@slayzone/tags/shared'
import { recordActivityEvents } from '@slayzone/history/main'

function buildTaskTagsChangedEvents(
  task: { id: string; project_id: string },
  previousTagIds: string[],
  nextTagIds: string[]
) {
  const previousSet = new Set(previousTagIds)
  const nextSet = new Set(nextTagIds)
  const addedTagIds = nextTagIds.filter((tagId) => !previousSet.has(tagId))
  const removedTagIds = previousTagIds.filter((tagId) => !nextSet.has(tagId))

  if (addedTagIds.length === 0 && removedTagIds.length === 0) {
    return []
  }

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

export function registerTagHandlers(ipcMain: IpcMain, db: Database): void {

  // Tags CRUD
  ipcMain.handle('db:tags:getAll', () => {
    return db.prepare('SELECT * FROM tags ORDER BY sort_order, name').all()
  })

  ipcMain.handle('db:tags:create', (_, data: CreateTagInput) => {
    const id = crypto.randomUUID()
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM tags WHERE project_id = ?').get(data.projectId) as { m: number }
    db.prepare('INSERT INTO tags (id, project_id, name, color, text_color, sort_order) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      data.projectId,
      data.name,
      data.color ?? '#6366f1',
      data.textColor ?? '#ffffff',
      maxOrder.m + 1
    )
    return db.prepare('SELECT * FROM tags WHERE id = ?').get(id)
  })

  ipcMain.handle('db:tags:update', (_, data: UpdateTagInput) => {
    const fields: string[] = []
    const values: unknown[] = []

    if (data.name !== undefined) {
      fields.push('name = ?')
      values.push(data.name)
    }
    if (data.color !== undefined) {
      fields.push('color = ?')
      values.push(data.color)
    }
    if (data.textColor !== undefined) {
      fields.push('text_color = ?')
      values.push(data.textColor)
    }
    if (data.sort_order !== undefined) {
      fields.push('sort_order = ?')
      values.push(data.sort_order)
    }

    if (fields.length > 0) {
      values.push(data.id)
      db.prepare(`UPDATE tags SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    }

    return db.prepare('SELECT * FROM tags WHERE id = ?').get(data.id)
  })

  ipcMain.handle('db:tags:delete', (_, id: string) => {
    const result = db.prepare('DELETE FROM tags WHERE id = ?').run(id)
    return result.changes > 0
  })

  ipcMain.handle('db:tags:reorder', (_, tagIds: string[]) => {
    const stmt = db.prepare('UPDATE tags SET sort_order = ? WHERE id = ?')
    db.transaction(() => {
      for (let i = 0; i < tagIds.length; i++) {
        stmt.run(i, tagIds[i])
      }
    })()
  })

  // Task-Tag associations
  ipcMain.handle('db:taskTags:getForTask', (_, taskId: string) => {
    return db
      .prepare(
        `SELECT tags.* FROM tags
         JOIN task_tags ON tags.id = task_tags.tag_id
         WHERE task_tags.task_id = ?
         ORDER BY tags.sort_order, tags.name`
      )
      .all(taskId)
  })

  ipcMain.handle('db:taskTags:getAll', () => {
    const rows = db.prepare('SELECT task_id, tag_id FROM task_tags').all() as { task_id: string; tag_id: string }[]
    const map: Record<string, string[]> = {}
    for (const row of rows) {
      if (!map[row.task_id]) map[row.task_id] = []
      map[row.task_id].push(row.tag_id)
    }
    return map
  })

  ipcMain.handle('db:taskTags:setForTask', (_, taskId: string, tagIds: string[]) => {
    const deleteStmt = db.prepare('DELETE FROM task_tags WHERE task_id = ?')
    const insertStmt = db.prepare('INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)')
    db.transaction(() => {
      const previousRows = db.prepare('SELECT tag_id FROM task_tags WHERE task_id = ? ORDER BY tag_id ASC').all(taskId) as Array<{ tag_id: string }>
      const previousTagIds = previousRows.map((row) => row.tag_id)
      deleteStmt.run(taskId)
      for (const tagId of tagIds) {
        insertStmt.run(taskId, tagId)
      }

      const taskRow = db.prepare('SELECT id, project_id FROM tasks WHERE id = ?').get(taskId) as { id: string; project_id: string } | undefined
      if (taskRow) {
        recordActivityEvents(db, buildTaskTagsChangedEvents(taskRow, previousTagIds, tagIds))
      }
    })()

    ipcMain.emit('db:taskTags:setForTask:done', null, taskId, tagIds)
  })
}
