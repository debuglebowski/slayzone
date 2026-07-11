import type { Express } from 'express'
import type { RestApiDeps } from '../types'
import { isResolveFailure, resolveByIdPrefix } from '../resolve'

/**
 * GET /api/tasks/:id/progress — read a task's progress (0-100).
 * Read complement of the CLI's `slay tasks progress` writer (which PATCHes
 * `/api/tasks/:id` with `{ progress }`).
 */
export function registerTaskProgressRoute(app: Express, deps: RestApiDeps): void {
  app.get('/api/tasks/:id/progress', async (req, res) => {
    try {
      const resolved = await resolveByIdPrefix<{ id: string; progress: number }>(
        deps.db,
        'tasks',
        req.params.id,
        'Task',
        'id, progress'
      )
      if (isResolveFailure(resolved)) {
        res.status(resolved.status).json({ ok: false, error: resolved.error })
        return
      }
      res.json({ ok: true, data: { id: resolved.row.id, progress: resolved.row.progress } })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
