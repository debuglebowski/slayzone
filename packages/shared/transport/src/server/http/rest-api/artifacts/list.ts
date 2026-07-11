import type { Express } from 'express'
import type { RestApiDeps } from '../types'
import { isResolveFailure, resolveByIdPrefix } from '../resolve'

/**
 * GET /api/tasks/:id/artifacts — list a task's artifacts + folders.
 * Mirrors `slay tasks artifacts list` (cli/src/commands/tasks/artifacts.ts):
 * task addressed by id prefix; both lists ordered by "order", created_at.
 * Response `{ folders, artifacts }` matches the CLI's `--json` shape.
 */
export function registerArtifactsListRoute(app: Express, deps: RestApiDeps): void {
  app.get('/api/tasks/:id/artifacts', async (req, res) => {
    try {
      const db = deps.db
      const task = await resolveByIdPrefix<{ id: string }>(db, 'tasks', req.params.id, 'Task', 'id')
      if (isResolveFailure(task)) {
        res.status(task.status).json({ ok: false, error: task.error })
        return
      }
      const artifacts = await db.all(
        `SELECT * FROM task_artifacts WHERE task_id = ? ORDER BY "order" ASC, created_at ASC`,
        [task.row.id]
      )
      const folders = await db.all(
        `SELECT * FROM artifact_folders WHERE task_id = ? ORDER BY "order" ASC, created_at ASC`,
        [task.row.id]
      )
      res.json({ ok: true, data: { folders, artifacts } })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
