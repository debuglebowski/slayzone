import type { Express } from 'express'
import type { RestApiDeps } from '../types'
import { queryString } from '../resolve'

/**
 * GET /api/tasks/search — title/description substring search.
 * Mirrors `slay tasks search` (cli/src/commands/tasks/search.ts): `q`
 * (required), `project` (id or name substring), `limit` (default 50).
 * NOTE: must be registered BEFORE GET /api/tasks/:id so "search" isn't
 * captured as an id prefix.
 */
export function registerSearchTasksRoute(app: Express, deps: RestApiDeps): void {
  app.get('/api/tasks/search', async (req, res) => {
    const query = queryString(req.query.q)
    if (!query || !query.trim()) {
      res.status(400).json({ ok: false, error: 'q required' })
      return
    }
    const project = queryString(req.query.project)
    const rawLimit = queryString(req.query.limit) ?? '50'
    const limit = parseInt(rawLimit, 10)
    if (!Number.isFinite(limit) || limit <= 0) {
      res.status(400).json({ ok: false, error: `Invalid limit: ${rawLimit}` })
      return
    }

    try {
      const q = `%${query.toLowerCase()}%`
      const conditions = [
        't.is_temporary = 0',
        't.deleted_at IS NULL',
        "(LOWER(t.title) LIKE ? OR LOWER(COALESCE(t.description, '')) LIKE ?)"
      ]
      const params: unknown[] = [q, q]
      if (project) {
        conditions.push('(p.id = ? OR LOWER(p.name) LIKE ?)')
        params.push(project, `%${project.toLowerCase()}%`)
      }

      const tasks = await deps.db.all(
        `SELECT t.id, t.title, t.status, t.priority, p.name AS project_name, t.created_at
         FROM tasks t JOIN projects p ON t.project_id = p.id
         WHERE ${conditions.join(' AND ')}
         ORDER BY t.updated_at DESC LIMIT ?`,
        [...params, limit]
      )
      res.json({ ok: true, data: tasks })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
