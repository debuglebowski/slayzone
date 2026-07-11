import type { Express } from 'express'
import type { RestApiDeps } from '../types'
import { isResolveFailure, resolveByIdPrefix } from '../resolve'

/**
 * GET /api/tasks/:id — single-task detail.
 * Mirrors `slay tasks view` (cli/src/commands/tasks/view.ts): id-prefix
 * addressing, full task row + project_name, tag names (sort_order, name),
 * dependency blockers and blocking (id + title each).
 */
export function registerGetTaskRoute(app: Express, deps: RestApiDeps): void {
  app.get('/api/tasks/:id', async (req, res) => {
    try {
      const db = deps.db
      const resolved = await resolveByIdPrefix<{ id: string }>(db, 'tasks', req.params.id, 'Task', 'id')
      if (isResolveFailure(resolved)) {
        res.status(resolved.status).json({ ok: false, error: resolved.error })
        return
      }
      const taskId = resolved.row.id

      const task = await db.get<Record<string, unknown>>(
        `SELECT t.*, p.name AS project_name
         FROM tasks t JOIN projects p ON t.project_id = p.id
         WHERE t.id = ?`,
        [taskId]
      )
      if (!task) {
        res.status(404).json({ ok: false, error: `Task not found: ${req.params.id}` })
        return
      }

      const tags = (
        await db.all<{ name: string }>(
          `SELECT tg.name FROM tags tg JOIN task_tags tt ON tg.id = tt.tag_id
           WHERE tt.task_id = ? ORDER BY tg.sort_order, tg.name`,
          [taskId]
        )
      ).map((r) => r.name)

      const blockers = await db.all<{ id: string; title: string }>(
        `SELECT t.id, t.title FROM tasks t JOIN task_dependencies td ON t.id = td.task_id
         WHERE td.blocks_task_id = ?`,
        [taskId]
      )
      const blocking = await db.all<{ id: string; title: string }>(
        `SELECT t.id, t.title FROM tasks t JOIN task_dependencies td ON t.id = td.blocks_task_id
         WHERE td.task_id = ?`,
        [taskId]
      )

      res.json({ ok: true, data: { ...task, tags, blockers, blocking } })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
