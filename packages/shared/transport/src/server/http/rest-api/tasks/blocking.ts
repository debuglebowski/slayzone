import type { Express } from 'express'
import type { RestApiDeps } from '../types'
import { isResolveFailure, resolveByIdPrefix } from '../resolve'

/**
 * GET /api/tasks/:id/blocking — tasks that :id blocks (reverse of blockers).
 * Mirrors `slay tasks blocking` (cli/src/commands/tasks/blocking.ts).
 */
export function registerTaskBlockingRoute(app: Express, deps: RestApiDeps): void {
  app.get('/api/tasks/:id/blocking', async (req, res) => {
    try {
      const db = deps.db
      const task = await resolveByIdPrefix<{ id: string }>(db, 'tasks', req.params.id, 'Task', 'id')
      if (isResolveFailure(task)) {
        res.status(task.status).json({ ok: false, error: task.error })
        return
      }
      const blocking = await db.all(
        `SELECT t.id, t.project_id, t.title, t.status, t.priority, p.name AS project_name, t.created_at
         FROM tasks t JOIN task_dependencies td ON t.id = td.blocks_task_id
         JOIN projects p ON t.project_id = p.id
         WHERE td.task_id = ?`,
        [task.row.id]
      )
      res.json({ ok: true, data: blocking })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
