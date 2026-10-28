import type { Express } from 'express'
import { createTag, deleteTag, updateTag } from '@slayzone/tags/server'
import type { RestApiDeps } from '../types'
import { isResolveFailure, queryString, resolveByIdPrefix, resolveProjectRef } from '../resolve'

/**
 * Project tag CRUD. Mirrors `slay tags` (cli/src/commands/tags.ts), reusing the
 * shared tag store (@slayzone/tags/server) for the writes:
 *
 * - GET    /api/tags?project=<id|name>  → project's tags (sort_order, name)
 * - POST   /api/tags   { project, name, color?, textColor? }
 * - PATCH  /api/tags/:id  { name?, color?, textColor?, sort_order? }
 * - DELETE /api/tags/:id  (id prefix supported)
 */
export function registerTagsCrudRoutes(app: Express, deps: RestApiDeps): void {
  app.get('/api/tags', async (req, res) => {
    const project = queryString(req.query.project)
    if (!project) {
      res.status(400).json({ ok: false, error: 'project required' })
      return
    }
    try {
      const resolved = await resolveProjectRef(deps.db, project)
      if (isResolveFailure(resolved)) {
        res.status(resolved.status).json({ ok: false, error: resolved.error })
        return
      }
      const tags = await deps.db.all(
        `SELECT * FROM tags WHERE project_id = ? ORDER BY sort_order, name`,
        [resolved.row.id]
      )
      res.json({ ok: true, data: tags })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/tags', async (req, res) => {
    const body = (req.body ?? {}) as {
      project?: unknown
      name?: unknown
      color?: unknown
      textColor?: unknown
    }
    if (typeof body.project !== 'string' || !body.project) {
      res.status(400).json({ ok: false, error: 'project required' })
      return
    }
    if (typeof body.name !== 'string' || !body.name.trim()) {
      res.status(400).json({ ok: false, error: 'name required' })
      return
    }
    try {
      const resolved = await resolveProjectRef(deps.db, body.project)
      if (isResolveFailure(resolved)) {
        res.status(resolved.status).json({ ok: false, error: resolved.error })
        return
      }
      const tag = await createTag(deps.db, {
        projectId: resolved.row.id,
        name: body.name,
        color: typeof body.color === 'string' ? body.color : undefined,
        textColor: typeof body.textColor === 'string' ? body.textColor : undefined
      })
      deps.notifyRenderer()
      res.json({ ok: true, data: tag })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.patch('/api/tags/:id', async (req, res) => {
    const body = (req.body ?? {}) as {
      name?: unknown
      color?: unknown
      textColor?: unknown
      sort_order?: unknown
    }
    try {
      const resolved = await resolveByIdPrefix<{ id: string }>(
        deps.db,
        'tags',
        req.params.id,
        'Tag',
        'id'
      )
      if (isResolveFailure(resolved)) {
        res.status(resolved.status).json({ ok: false, error: resolved.error })
        return
      }
      const tag = await updateTag(deps.db, {
        id: resolved.row.id,
        name: typeof body.name === 'string' ? body.name : undefined,
        color: typeof body.color === 'string' ? body.color : undefined,
        textColor: typeof body.textColor === 'string' ? body.textColor : undefined,
        sort_order: typeof body.sort_order === 'number' ? body.sort_order : undefined
      })
      deps.notifyRenderer()
      res.json({ ok: true, data: tag })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete('/api/tags/:id', async (req, res) => {
    try {
      const resolved = await resolveByIdPrefix<{ id: string; name: string }>(
        deps.db,
        'tags',
        req.params.id,
        'Tag',
        'id, name'
      )
      if (isResolveFailure(resolved)) {
        res.status(resolved.status).json({ ok: false, error: resolved.error })
        return
      }
      await deleteTag(deps.db, resolved.row.id)
      deps.notifyRenderer()
      res.json({ ok: true, data: { id: resolved.row.id, name: resolved.row.name } })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
