import type { Express } from 'express'
import type { RestApiDeps } from '../types'

/**
 * GET /api/projects — list all projects with live task counts.
 * Mirrors `slay projects list` (cli/src/commands/projects.ts): the count only
 * includes non-archived, non-deleted, non-temporary tasks.
 */
export function registerProjectsListRoute(app: Express, deps: RestApiDeps): void {
  app.get('/api/projects', async (_req, res) => {
    try {
      const projects = await deps.db.all(
        `SELECT p.id, p.name, p.path,
           COUNT(t.id) FILTER (WHERE t.archived_at IS NULL AND t.deleted_at IS NULL AND t.is_temporary = 0) AS task_count
         FROM projects p
         LEFT JOIN tasks t ON t.project_id = p.id
         GROUP BY p.id
         ORDER BY p.name ASC`
      )
      res.json({ ok: true, data: projects })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
