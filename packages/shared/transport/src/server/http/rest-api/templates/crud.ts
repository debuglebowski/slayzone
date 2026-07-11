import type { Express, Response } from 'express'
import {
  createTemplate,
  deleteTemplate,
  getTemplate,
  listTemplatesByProject,
  updateTemplate
} from '@slayzone/task/server'
import type { UpdateTaskTemplateInput } from '@slayzone/task/shared'
import type { TerminalMode } from '@slayzone/terminal/shared'
import type { RestApiDeps } from '../types'
import { isResolveFailure, queryString, resolveByIdPrefix, resolveProjectRef } from '../resolve'

/**
 * Task-template CRUD. Mirrors `slay templates` (cli/src/commands/templates.ts),
 * reusing the shared template store (@slayzone/task/server) — which also owns
 * the "creating/updating a default clears the previous default" invariant:
 *
 * - GET    /api/templates?project=<id|name>
 * - GET    /api/templates/:id          (id prefix supported)
 * - POST   /api/templates   { project, name, description?, terminalMode?, status?, priority?, isDefault? }
 * - PATCH  /api/templates/:id  (same optional fields as POST minus project)
 * - DELETE /api/templates/:id
 */

/** CLI parity: priority must be an integer 1-5. Writes the 400 itself. */
function validPriority(value: unknown, res: Response): number | null | undefined {
  if (value === undefined) return undefined
  const p = typeof value === 'number' ? value : parseInt(String(value), 10)
  if (isNaN(p) || p < 1 || p > 5 || !Number.isInteger(p)) {
    res.status(400).json({ ok: false, error: 'Priority must be 1-5.' })
    return null
  }
  return p
}

export function registerTemplatesCrudRoutes(app: Express, deps: RestApiDeps): void {
  app.get('/api/templates', async (req, res) => {
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
      res.json({ ok: true, data: await listTemplatesByProject(deps.db, resolved.row.id) })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/api/templates/:id', async (req, res) => {
    try {
      const resolved = await resolveByIdPrefix<{ id: string }>(
        deps.db,
        'task_templates',
        req.params.id,
        'Template',
        'id'
      )
      if (isResolveFailure(resolved)) {
        res.status(resolved.status).json({ ok: false, error: resolved.error })
        return
      }
      res.json({ ok: true, data: await getTemplate(deps.db, resolved.row.id) })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/templates', async (req, res) => {
    const body = (req.body ?? {}) as {
      project?: unknown
      name?: unknown
      description?: unknown
      terminalMode?: unknown
      status?: unknown
      priority?: unknown
      isDefault?: unknown
    }
    if (typeof body.project !== 'string' || !body.project) {
      res.status(400).json({ ok: false, error: 'project required' })
      return
    }
    if (typeof body.name !== 'string' || !body.name.trim()) {
      res.status(400).json({ ok: false, error: 'name required' })
      return
    }
    const priority = validPriority(body.priority, res)
    if (priority === null) return
    try {
      const resolved = await resolveProjectRef(deps.db, body.project)
      if (isResolveFailure(resolved)) {
        res.status(resolved.status).json({ ok: false, error: resolved.error })
        return
      }
      const template = await createTemplate(deps.db, {
        projectId: resolved.row.id,
        name: body.name,
        description: typeof body.description === 'string' ? body.description : null,
        terminalMode:
          typeof body.terminalMode === 'string' ? (body.terminalMode as TerminalMode) : null,
        defaultStatus: typeof body.status === 'string' ? body.status : null,
        defaultPriority: priority ?? null,
        isDefault: body.isDefault === true
      })
      deps.notifyRenderer()
      res.json({ ok: true, data: template })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.patch('/api/templates/:id', async (req, res) => {
    const body = (req.body ?? {}) as {
      name?: unknown
      description?: unknown
      terminalMode?: unknown
      status?: unknown
      priority?: unknown
      isDefault?: unknown
    }
    if (
      body.name === undefined &&
      body.description === undefined &&
      body.terminalMode === undefined &&
      body.status === undefined &&
      body.priority === undefined &&
      body.isDefault === undefined
    ) {
      res.status(400).json({ ok: false, error: 'Provide at least one option to update.' })
      return
    }
    const priority = validPriority(body.priority, res)
    if (priority === null) return
    try {
      const resolved = await resolveByIdPrefix<{ id: string }>(
        deps.db,
        'task_templates',
        req.params.id,
        'Template',
        'id'
      )
      if (isResolveFailure(resolved)) {
        res.status(resolved.status).json({ ok: false, error: resolved.error })
        return
      }
      // Only forward provided keys — updateTemplate builds its SET clause from
      // key presence (`key in data`), mirroring the CLI's per-flag updates.
      const input: UpdateTaskTemplateInput = { id: resolved.row.id }
      if (typeof body.name === 'string') input.name = body.name
      if (body.description !== undefined) {
        input.description = typeof body.description === 'string' ? body.description : null
      }
      if (typeof body.terminalMode === 'string') {
        input.terminalMode = body.terminalMode as TerminalMode
      }
      if (typeof body.status === 'string') input.defaultStatus = body.status
      if (priority !== undefined) input.defaultPriority = priority
      if (typeof body.isDefault === 'boolean') input.isDefault = body.isDefault

      const template = await updateTemplate(deps.db, input)
      if (!template) {
        res.status(404).json({ ok: false, error: `Template not found: ${req.params.id}` })
        return
      }
      deps.notifyRenderer()
      res.json({ ok: true, data: template })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete('/api/templates/:id', async (req, res) => {
    try {
      const resolved = await resolveByIdPrefix<{ id: string; name: string }>(
        deps.db,
        'task_templates',
        req.params.id,
        'Template',
        'id, name'
      )
      if (isResolveFailure(resolved)) {
        res.status(resolved.status).json({ ok: false, error: resolved.error })
        return
      }
      await deleteTemplate(deps.db, resolved.row.id)
      deps.notifyRenderer()
      res.json({ ok: true, data: { id: resolved.row.id, name: resolved.row.name } })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
