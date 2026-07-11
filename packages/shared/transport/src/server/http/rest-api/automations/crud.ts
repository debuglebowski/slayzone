import type { Express } from 'express'
import {
  createAutomation,
  deleteAutomation,
  getAutomation,
  listAutomationsByProject,
  updateAutomation
} from '@slayzone/automations/server'
import type {
  ActionConfig,
  ConditionConfig,
  TriggerConfig,
  UpdateAutomationInput
} from '@slayzone/automations/shared'
import type { RestApiDeps } from '../types'
import { isResolveFailure, queryString, resolveByIdPrefix, resolveProjectRef } from '../resolve'

/**
 * Automation CRUD. Mirrors `slay automations` (cli/src/commands/automations.ts),
 * reusing the shared automations store (@slayzone/automations/server). Manual
 * execution already exists as POST /api/automations/:id/run (automations/run.ts):
 *
 * - GET    /api/automations?project=<id|name>
 * - GET    /api/automations/:id      (id prefix supported)
 * - POST   /api/automations   { project, name, trigger_config, actions, description?, conditions?, catchup_on_start? }
 * - PATCH  /api/automations/:id  { name?, description?, enabled?, trigger_config?, conditions?, actions?, sort_order?, catchup_on_start? }
 * - DELETE /api/automations/:id
 */
export function registerAutomationsCrudRoutes(app: Express, deps: RestApiDeps): void {
  app.get('/api/automations', async (req, res) => {
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
      res.json({ ok: true, data: await listAutomationsByProject(deps.db, resolved.row.id) })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/api/automations/:id', async (req, res) => {
    try {
      const resolved = await resolveByIdPrefix<{ id: string }>(
        deps.db,
        'automations',
        req.params.id,
        'Automation',
        'id'
      )
      if (isResolveFailure(resolved)) {
        res.status(resolved.status).json({ ok: false, error: resolved.error })
        return
      }
      res.json({ ok: true, data: await getAutomation(deps.db, resolved.row.id) })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  // Execution history for an automation (CLI `slay automations runs`).
  app.get('/api/automations/:id/runs', async (req, res) => {
    const rawLimit = queryString(req.query.limit) ?? '10'
    const limit = parseInt(rawLimit, 10)
    if (!Number.isFinite(limit) || limit <= 0) {
      res.status(400).json({ ok: false, error: `Invalid limit: ${rawLimit}` })
      return
    }
    try {
      const resolved = await resolveByIdPrefix<{ id: string }>(
        deps.db,
        'automations',
        req.params.id,
        'Automation',
        'id'
      )
      if (isResolveFailure(resolved)) {
        res.status(resolved.status).json({ ok: false, error: resolved.error })
        return
      }
      const runs = await deps.db.all(
        `SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT ?`,
        [resolved.row.id, limit]
      )
      res.json({ ok: true, data: runs })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/automations', async (req, res) => {
    const body = (req.body ?? {}) as {
      project?: unknown
      name?: unknown
      description?: unknown
      trigger_config?: unknown
      conditions?: unknown
      actions?: unknown
      catchup_on_start?: unknown
    }
    if (typeof body.project !== 'string' || !body.project) {
      res.status(400).json({ ok: false, error: 'project required' })
      return
    }
    if (typeof body.name !== 'string' || !body.name.trim()) {
      res.status(400).json({ ok: false, error: 'name required' })
      return
    }
    // CLI parity (config-file path): trigger_config + non-empty actions required.
    if (
      !body.trigger_config ||
      typeof body.trigger_config !== 'object' ||
      !Array.isArray(body.actions) ||
      body.actions.length === 0
    ) {
      res.status(400).json({ ok: false, error: 'trigger_config and actions required' })
      return
    }
    try {
      const resolved = await resolveProjectRef(deps.db, body.project)
      if (isResolveFailure(resolved)) {
        res.status(resolved.status).json({ ok: false, error: resolved.error })
        return
      }
      const automation = await createAutomation(deps.db, {
        project_id: resolved.row.id,
        name: body.name,
        description: typeof body.description === 'string' ? body.description : undefined,
        trigger_config: body.trigger_config as TriggerConfig,
        conditions: Array.isArray(body.conditions)
          ? (body.conditions as ConditionConfig[])
          : undefined,
        actions: body.actions as ActionConfig[],
        catchup_on_start: body.catchup_on_start === false ? false : undefined
      })
      deps.notifyRenderer()
      res.json({ ok: true, data: automation })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.patch('/api/automations/:id', async (req, res) => {
    const body = (req.body ?? {}) as {
      name?: unknown
      description?: unknown
      enabled?: unknown
      trigger_config?: unknown
      conditions?: unknown
      actions?: unknown
      sort_order?: unknown
      catchup_on_start?: unknown
    }
    if (
      body.name === undefined &&
      body.description === undefined &&
      body.enabled === undefined &&
      body.trigger_config === undefined &&
      body.conditions === undefined &&
      body.actions === undefined &&
      body.sort_order === undefined &&
      body.catchup_on_start === undefined
    ) {
      res.status(400).json({ ok: false, error: 'Provide at least one option to update.' })
      return
    }
    try {
      const resolved = await resolveByIdPrefix<{ id: string }>(
        deps.db,
        'automations',
        req.params.id,
        'Automation',
        'id'
      )
      if (isResolveFailure(resolved)) {
        res.status(resolved.status).json({ ok: false, error: resolved.error })
        return
      }
      const input: UpdateAutomationInput = { id: resolved.row.id }
      if (typeof body.name === 'string') input.name = body.name
      if (typeof body.description === 'string') input.description = body.description
      if (typeof body.enabled === 'boolean') input.enabled = body.enabled
      if (body.trigger_config && typeof body.trigger_config === 'object') {
        input.trigger_config = body.trigger_config as TriggerConfig
      }
      if (Array.isArray(body.conditions)) input.conditions = body.conditions as ConditionConfig[]
      if (Array.isArray(body.actions)) input.actions = body.actions as ActionConfig[]
      if (typeof body.sort_order === 'number') input.sort_order = body.sort_order
      if (typeof body.catchup_on_start === 'boolean') {
        input.catchup_on_start = body.catchup_on_start
      }

      const automation = await updateAutomation(deps.db, input)
      deps.notifyRenderer()
      res.json({ ok: true, data: automation })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete('/api/automations/:id', async (req, res) => {
    try {
      const resolved = await resolveByIdPrefix<{ id: string; name: string }>(
        deps.db,
        'automations',
        req.params.id,
        'Automation',
        'id, name'
      )
      if (isResolveFailure(resolved)) {
        res.status(resolved.status).json({ ok: false, error: resolved.error })
        return
      }
      await deleteAutomation(deps.db, resolved.row.id)
      deps.notifyRenderer()
      res.json({ ok: true, data: { id: resolved.row.id, name: resolved.row.name } })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
