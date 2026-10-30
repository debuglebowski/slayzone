import type { Express } from 'express'
import { listAllProjects, projectFolderOf } from '@slayzone/projects/server'
import type { RestApiDeps } from '../types'

/**
 * GET /api/projects — list all projects with live task counts.
 * Mirrors `slay projects list` (cli/src/commands/projects.ts): the count only
 * includes non-archived, non-deleted, non-temporary tasks.
 *
 * `path` is the project-wide folder (`projectFolderOf`): on the computer the hub uses
 * for the project, else the legacy column until it is dropped.
 */
export function registerProjectsListRoute(app: Express, deps: RestApiDeps): void {
  app.get('/api/projects', async (_req, res) => {
    try {
      const rows = await deps.db.all<{
        id: string
        name: string
        legacy_path: string | null
        task_count: number
      }>(
        `SELECT p.id, p.name, p.path AS legacy_path,
           COUNT(t.id) FILTER (WHERE t.archived_at IS NULL AND t.deleted_at IS NULL AND t.is_temporary = 0) AS task_count
         FROM projects p
         LEFT JOIN tasks t ON t.project_id = p.id
         GROUP BY p.id
         ORDER BY p.name ASC`
      )
      const projects = new Map((await listAllProjects(deps.db)).map((p) => [p.id, p]))
      res.json({
        ok: true,
        data: rows.map((r) => ({
          id: r.id,
          name: r.name,
          path: (() => {
            const project = projects.get(r.id)
            return project ? projectFolderOf(project, r.legacy_path) : r.legacy_path
          })(),
          task_count: r.task_count
        }))
      })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
