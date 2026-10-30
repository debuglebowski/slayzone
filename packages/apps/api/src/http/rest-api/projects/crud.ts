import type { Express } from 'express'
import { getComputer, setProjectDefaultComputer } from '@slayzone/computers/server'
import { createProject, projectFolder, updateProject } from '@slayzone/projects/server'
import type { CreateProjectInput, UpdateProjectInput } from '@slayzone/projects-contracts'
import type { RestApiDeps } from '../types'
import { restPrincipalOf } from '../principal'
import { isResolveFailure, resolveProjectRef } from '../resolve'

/**
 * Project create/update. Mirrors `slay projects create` / `update`
 * (cli/src/commands/projects.ts), reusing the shared project store
 * (@slayzone/projects/server) — the same create/update ops behind the app's
 * tRPC `projects` router (sort_order allocation, columns remap, etc.).
 *
 * - POST  /api/projects   { name, color?, path?, computerId?, columnsConfig? }
 * - PATCH /api/projects/:id  { name?, color?, path?, computerId? }  (id or name substring)
 *
 * `computerId` is the project's default computer — where its agents run — on both.
 * `path` is the project's folder on that computer; without `computerId` it is the
 * caller's default computer (create) or the computer the hub uses for the project
 * (update).
 * The store records it on that computer (`project-folders.ts`). The CLI still
 * normalizes `path` and creates the directory before calling these. `iconsDir` is unused on these two paths
 * (icons only mutate on the update fields the CLI never sends), so an empty
 * string is safe here — no icon file is ever touched.
 */
export function registerProjectsCrudRoutes(app: Express, deps: RestApiDeps): void {
  app.post('/api/projects', async (req, res) => {
    const body = (req.body ?? {}) as {
      name?: unknown
      color?: unknown
      path?: unknown
      computerId?: unknown
      columnsConfig?: unknown
    }
    if (typeof body.name !== 'string' || !body.name.trim()) {
      res.status(400).json({ ok: false, error: 'name required' })
      return
    }
    const input: CreateProjectInput = { name: body.name, color: '#3b82f6' }
    if (typeof body.color === 'string') input.color = body.color
    if (typeof body.path === 'string') input.path = body.path
    if (typeof body.computerId === 'string') input.computerId = body.computerId
    if (Array.isArray(body.columnsConfig)) {
      input.columnsConfig = body.columnsConfig as CreateProjectInput['columnsConfig']
    }
    try {
      // Owner = the signed-in user; null on a hub without login (no principal).
      const project = await createProject(deps.db, input, restPrincipalOf(req)?.userId ?? null)
      deps.notifyRenderer()
      res.json({ ok: true, data: { ...project, path: await projectFolder(deps.db, project.id) } })
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.patch('/api/projects/:id', async (req, res) => {
    const body = (req.body ?? {}) as {
      name?: unknown
      color?: unknown
      path?: unknown
      computerId?: unknown
    }
    if (
      body.name === undefined &&
      body.color === undefined &&
      body.path === undefined &&
      body.computerId === undefined
    ) {
      res
        .status(400)
        .json({ ok: false, error: 'Provide at least one of name, color, path, computerId' })
      return
    }
    if (body.computerId !== undefined && typeof body.computerId !== 'string') {
      res.status(400).json({ ok: false, error: 'computerId must be a string' })
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
      // The default computer first, so `path` is recorded on the NEW computer. Put
      // back if the update then fails (e.g. that computer refuses the folder):
      // nothing half-applied.
      const computerId = body.computerId as string | undefined
      let previousComputerId: string | null = null
      if (computerId !== undefined) {
        previousComputerId =
          (
            await deps.db.get<{ default_computer_id: string | null }>(
              'SELECT default_computer_id FROM projects WHERE id = ?',
              [resolved.row.id]
            )
          )?.default_computer_id ?? null
        if (!(await getComputer(deps.db, computerId))) {
          res.status(400).json({ ok: false, error: `Unknown computer: ${computerId}` })
          return
        }
        await setProjectDefaultComputer(deps.db, resolved.row.id, computerId)
      }
      const project = await updateProject(deps.db, input, '').catch(async (err: unknown) => {
        if (computerId !== undefined)
          await setProjectDefaultComputer(deps.db, resolved.row.id, previousComputerId)
        throw err
      })
      deps.notifyRenderer()
      res.json({ ok: true, data: { ...project, path: await projectFolder(deps.db, project.id) } })
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
