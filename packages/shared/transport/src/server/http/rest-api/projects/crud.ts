import type { Express } from 'express'
import { createProject, updateProject } from '@slayzone/projects/server'
import type { CreateProjectInput, UpdateProjectInput } from '@slayzone/projects/shared'
import type { RestApiDeps } from '../types'
import { isResolveFailure, resolveProjectRef } from '../resolve'

/**
 * Project create/update. Mirrors `slay projects create` / `update`
 * (cli/src/commands/projects.ts), reusing the shared project store
 * (@slayzone/projects/server) — the same create/update ops behind the app's
 * tRPC `projects` router (sort_order allocation, columns remap, etc.).
 *
 * - POST  /api/projects   { name, color?, path?, columnsConfig? }
 * - PATCH /api/projects/:id  { name?, color?, path? }  (id or name substring)
 *
 * The CLI still owns filesystem side effects (mkdir/normalize of `path`) — it
 * resolves the absolute path and creates the directory before calling these,
 * so the routes persist metadata only. `iconsDir` is unused on these two paths
 * (icons only mutate on the update fields the CLI never sends), so an empty
 * string is safe here — no icon file is ever touched.
 */
export function registerProjectsCrudRoutes(app: Express, deps: RestApiDeps): void {
  app.post('/api/projects', async (req, res) => {
    const body = (req.body ?? {}) as {
      name?: unknown
      color?: unknown
      path?: unknown
      columnsConfig?: unknown
    }
    if (typeof body.name !== 'string' || !body.name.trim()) {
      res.status(400).json({ ok: false, error: 'name required' })
      return
    }
    const input: CreateProjectInput = { name: body.name, color: '#3b82f6' }
    if (typeof body.color === 'string') input.color = body.color
    if (typeof body.path === 'string') input.path = body.path
    if (Array.isArray(body.columnsConfig)) {
      input.columnsConfig = body.columnsConfig as CreateProjectInput['columnsConfig']
    }
    try {
      const project = await createProject(deps.db, input)
      deps.notifyRenderer()
      res.json({ ok: true, data: project })
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.patch('/api/projects/:id', async (req, res) => {
    const body = (req.body ?? {}) as { name?: unknown; color?: unknown; path?: unknown }
    if (body.name === undefined && body.color === undefined && body.path === undefined) {
      res.status(400).json({ ok: false, error: 'Provide at least one of name, color, path' })
      return
    }
    try {
      const resolved = await resolveProjectRef(deps.db, req.params.id)
      if (isResolveFailure(resolved)) {
        res.status(resolved.status).json({ ok: false, error: resolved.error })
        return
      }
      const input: UpdateProjectInput = { id: resolved.row.id }
      if (typeof body.name === 'string') input.name = body.name
      if (typeof body.color === 'string') input.color = body.color
      if (body.path !== undefined) input.path = typeof body.path === 'string' ? body.path : null
      const project = await updateProject(deps.db, input, '')
      deps.notifyRenderer()
      res.json({ ok: true, data: project })
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
