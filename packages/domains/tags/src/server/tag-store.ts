import { randomUUID } from 'node:crypto'
import type { SlayzoneDb } from '@slayzone/platform'
import type { CreateTagInput, Tag, UpdateTagInput } from '../shared'

export async function listAllTags(db: SlayzoneDb): Promise<Tag[]> {
  return (await db.prepare('SELECT * FROM tags ORDER BY sort_order, name').all()) as Tag[]
}

export async function createTag(db: SlayzoneDb, data: CreateTagInput): Promise<Tag> {
  const id = randomUUID()
  const maxOrder = (await db
    .prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM tags WHERE project_id = ?')
    .get(data.projectId)) as { m: number }
  await db
    .prepare(
      'INSERT INTO tags (id, project_id, name, color, text_color, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(
      id,
      data.projectId,
      data.name,
      data.color ?? '#6366f1',
      data.textColor ?? '#ffffff',
      maxOrder.m + 1
    )
  return (await db.prepare('SELECT * FROM tags WHERE id = ?').get(id)) as Tag
}

export async function updateTag(db: SlayzoneDb, data: UpdateTagInput): Promise<Tag> {
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
    await db.prepare(`UPDATE tags SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  }
  return (await db.prepare('SELECT * FROM tags WHERE id = ?').get(data.id)) as Tag
}

export async function deleteTag(db: SlayzoneDb, id: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM tags WHERE id = ?').run(id)
  return result.changes > 0
}

export async function reorderTags(db: SlayzoneDb, tagIds: string[]): Promise<void> {
  await db.batchTxn(
    tagIds.map((tagId, i) => ({
      type: 'run' as const,
      sql: 'UPDATE tags SET sort_order = ? WHERE id = ?',
      params: [i, tagId]
    }))
  )
}

export async function getTagsForTask(db: SlayzoneDb, taskId: string): Promise<Tag[]> {
  return (await db
    .prepare(
      `SELECT tags.* FROM tags
       JOIN task_tags ON tags.id = task_tags.tag_id
       WHERE task_tags.task_id = ?
       ORDER BY tags.sort_order, tags.name`
    )
    .all(taskId)) as Tag[]
}

export async function getAllTaskTagIds(db: SlayzoneDb): Promise<Record<string, string[]>> {
  const rows = (await db
    .prepare('SELECT task_id, tag_id FROM task_tags')
    .all()) as { task_id: string; tag_id: string }[]
  const map: Record<string, string[]> = {}
  for (const row of rows) {
    if (!map[row.task_id]) map[row.task_id] = []
    map[row.task_id].push(row.tag_id)
  }
  return map
}

export async function setTagsForTask(
  db: SlayzoneDb,
  taskId: string,
  tagIds: string[]
): Promise<void> {
  await db.namedTxn('tags:setForTask', { taskId, tagIds })
}
