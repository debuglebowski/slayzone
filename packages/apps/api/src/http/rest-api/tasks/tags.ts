import type { Express, Response } from 'express'
import type { SlayzoneDb } from '@slayzone/platform'
import type { RestApiDeps } from '../types'
import { isResolveFailure, resolveByIdPrefix } from '../resolve'

/**
 * Tag assignment on a task (by tag NAME within the task's project).
 * Mirrors `slay tasks tag` (cli/src/commands/tasks/tag.ts):
 *
 * - POST   /api/tasks/:id/tags  { add: string } | { set: string[] }
 * - DELETE /api/tasks/:id/tags  { remove: string } | { clear: true }
 *
 * Tag names resolve case-insensitively within the task's project (404 when
 * unknown). Writes respond with the resulting tag-name list (CLI parity) and
 * ping the renderer. Current tags are also readable via GET /api/tasks/:id.
 */

interface TaskRow {
  id: string
  project_id: string
}

async function currentTagNames(db: SlayzoneDb, taskId: string): Promise<string[]> {
  const rows = await db.all<{ name: string }>(
    `SELECT tg.name FROM tags tg JOIN task_tags tt ON tg.id = tt.tag_id
     WHERE tt.task_id = ? ORDER BY tg.sort_order, tg.name`,
    [taskId]
  )
  return rows.map((r) => r.name)
}

/** Resolve a tag name in the project; writes the 404 response itself on miss. */
async function resolveTagByName(
  db: SlayzoneDb,
  projectId: string,
  name: string,
  res: Response
): Promise<string | null> {
  const tag = await db.get<{ id: string }>(
    `SELECT id, name FROM tags WHERE project_id = ? AND LOWER(name) = LOWER(?)`,
    [projectId, name]
  )
  if (!tag) {
    res.status(404).json({ ok: false, error: `Tag not found: "${name}" in this project` })
    return null
  }
  return tag.id
}

export function registerTaskTagsRoutes(app: Express, deps: RestApiDeps): void {
  app.post('/api/tasks/:id/tags', async (req, res) => {
    const body = (req.body ?? {}) as { add?: unknown; set?: unknown }
    const hasAdd = typeof body.add === 'string' && body.add.length > 0
    const hasSet = Array.isArray(body.set) && body.set.every((s) => typeof s === 'string')
    if (hasAdd === hasSet) {
      res
        .status(400)
        .json({ ok: false, error: 'Provide exactly one of add (string), set (string[])' })
      return
    }
    try {
      const db = deps.db
      const resolved = await resolveByIdPrefix<TaskRow>(
        db,
        'tasks',
        req.params.id,
        'Task',
        'id, project_id'
      )
      if (isResolveFailure(resolved)) {
        res.status(resolved.status).json({ ok: false, error: resolved.error })
        return
      }
      const task = resolved.row

      if (hasSet) {
        const tagIds: string[] = []
        for (const name of body.set as string[]) {
          const tagId = await resolveTagByName(db, task.project_id, name, res)
          if (!tagId) return
          tagIds.push(tagId)
        }
        await db.batchTxn([
          { type: 'run', sql: `DELETE FROM task_tags WHERE task_id = ?`, params: [task.id] },
          ...tagIds.map((tagId) => ({
            type: 'run' as const,
            sql: `INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)`,
            params: [task.id, tagId]
          }))
        ])
      } else {
        const tagId = await resolveTagByName(db, task.project_id, body.add as string, res)
        if (!tagId) return
        await db.run(`INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)`, [
          task.id,
          tagId
        ])
      }

      deps.notifyRenderer()
      res.json({ ok: true, data: await currentTagNames(db, task.id) })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete('/api/tasks/:id/tags', async (req, res) => {
    const body = (req.body ?? {}) as { remove?: unknown; clear?: unknown }
    const hasRemove = typeof body.remove === 'string' && body.remove.length > 0
    const clear = body.clear === true
    if (hasRemove === clear) {
      res.status(400).json({ ok: false, error: 'Provide exactly one of remove (string), clear' })
      return
    }
    try {
      const db = deps.db
      const resolved = await resolveByIdPrefix<TaskRow>(
        db,
        'tasks',
        req.params.id,
        'Task',
        'id, project_id'
      )
      if (isResolveFailure(resolved)) {
        res.status(resolved.status).json({ ok: false, error: resolved.error })
        return
      }
      const task = resolved.row

      if (clear) {
        await db.run(`DELETE FROM task_tags WHERE task_id = ?`, [task.id])
      } else {
        const tagId = await resolveTagByName(db, task.project_id, body.remove as string, res)
        if (!tagId) return
        await db.run(`DELETE FROM task_tags WHERE task_id = ? AND tag_id = ?`, [task.id, tagId])
      }

      deps.notifyRenderer()
      res.json({ ok: true, data: await currentTagNames(db, task.id) })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
