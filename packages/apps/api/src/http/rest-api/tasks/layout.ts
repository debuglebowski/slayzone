import type { IncomingMessage } from 'node:http'
import type { Express, Request, Response } from 'express'
import {
  AGENT_CALLER,
  applyLayoutInputSchema,
  CALLER_HEADER,
  describeZodError,
  LAYOUT_LOCKED_CODE,
  openPanelInputSchema,
  updatePanelInputSchema
} from '@slayzone/task-contracts'
import {
  changeTaskLayoutOp,
  readTaskLayoutOp,
  readTaskLayoutSettings,
  TaskLayoutChangeError,
  type TaskLayoutChange,
  type TaskLayoutSettings
} from '@slayzone/task/server'
import type { RestApiDeps } from '../types'
import { NOOP_TASK_BUS } from '../types'
import { isResolveFailure, resolveByIdPrefix } from '../resolve'
import { restComputerOf, restPrincipalOf } from '../principal'
import { respondFrameTooLarge } from '../computer-frame-limit'

/**
 * A task's panel layout from outside the task view (docs/plans/panel-model.md step
 * 13) — `slay panels layout …`:
 *
 * - GET    /api/tasks/:id/layout                 → { layout, definitions, agentMayChangeLayout }
 * - PUT    /api/tasks/:id/layout                 { layoutId } | { layout }
 * - POST   /api/tasks/:id/panels                 { kind, settings?, placement?, name? }
 * - PATCH  /api/tasks/:id/panels/:instanceId     { hidden?, name?, settings? }
 * - DELETE /api/tasks/:id/panels/:instanceId     (a primary panel only hides)
 *
 * `:id` is a full id or a unique prefix. The layout is the one the caller's task
 * view renders (their `panel_config` / `task_layouts`, per user on a login hub).
 * Every write is one layout op through `updateTask({panelLayout})`, so it bumps the
 * rev, dual-writes the legacy columns and reaches open task views with the row.
 *
 * A request from an agent session — through a computer's CLI relay, or carrying
 * `x-slayzone-caller: agent` (a task terminal's `slay`) — is refused with 403
 * `layout_locked` while the user's `agent_may_change_layout` is '0', and its change
 * is offered for Undo in the task view. The header is a courtesy marker, not a
 * credential: the setting is the user's preference about their agents, and an agent
 * holds the user's own access either way.
 */

function isAgentRequest(req: IncomingMessage): boolean {
  return restComputerOf(req) !== null || req.headers[CALLER_HEADER] === AGENT_CALLER
}

async function resolveTask(deps: RestApiDeps, req: Request, res: Response): Promise<string | null> {
  const resolved = await resolveByIdPrefix<{ id: string }>(
    deps.db,
    'tasks',
    String(req.params.id),
    'Task',
    'id'
  )
  if (isResolveFailure(resolved)) {
    res.status(resolved.status).json({ ok: false, error: resolved.error })
    return null
  }
  return resolved.row.id
}

function settingsFor(deps: RestApiDeps, req: IncomingMessage): Promise<TaskLayoutSettings> {
  return readTaskLayoutSettings(deps.db, restPrincipalOf(req)?.userId ?? null)
}

function respondError(res: Response, err: unknown): void {
  if (respondFrameTooLarge(res, err)) return
  if (err instanceof TaskLayoutChangeError) {
    res.status(err.status).json({ ok: false, error: err.message })
    return
  }
  res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
}

/** Resolve the task, check the agent gate, apply `change`, answer with the result. */
async function applyChange(
  deps: RestApiDeps,
  req: Request,
  res: Response,
  change: TaskLayoutChange
): Promise<void> {
  try {
    const taskId = await resolveTask(deps, req, res)
    if (!taskId) return
    const settings = await settingsFor(deps, req)
    const fromAgent = isAgentRequest(req)
    if (fromAgent && !settings.agentMayChangeLayout) {
      res.status(403).json({
        ok: false,
        code: LAYOUT_LOCKED_CODE,
        error:
          'The user does not let agents change the task layout ("Agent may change the layout" in Manage layouts).'
      })
      return
    }
    const result = await changeTaskLayoutOp(deps.db, taskId, change, settings, {
      opDeps: { ipcMain: deps.taskBus ?? NOOP_TASK_BUS, onMutation: deps.notifyRenderer },
      origin: fromAgent ? 'agent' : 'user'
    })
    res.json({ ok: true, data: { taskId, ...result } })
  } catch (err) {
    respondError(res, err)
  }
}

export function registerTaskLayoutRoutes(app: Express, deps: RestApiDeps): void {
  app.get('/api/tasks/:id/layout', async (req, res) => {
    try {
      const taskId = await resolveTask(deps, req, res)
      if (!taskId) return
      const view = await readTaskLayoutOp(deps.db, taskId, await settingsFor(deps, req))
      if (!view) {
        res.status(404).json({ ok: false, error: `Task not found: ${req.params.id}` })
        return
      }
      res.json({ ok: true, data: view })
    } catch (err) {
      respondError(res, err)
    }
  })

  app.put('/api/tasks/:id/layout', async (req, res) => {
    const parsed = applyLayoutInputSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: `Give either layoutId or layout. ${describeZodError(parsed.error)}`
      })
      return
    }
    const change: TaskLayoutChange =
      'layoutId' in parsed.data
        ? { type: 'apply', layoutId: parsed.data.layoutId }
        : { type: 'replace', layout: parsed.data.layout }
    await applyChange(deps, req, res, change)
  })

  app.post('/api/tasks/:id/panels', async (req, res) => {
    const parsed = openPanelInputSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: describeZodError(parsed.error) })
      return
    }
    await applyChange(deps, req, res, { type: 'open', ...parsed.data })
  })

  app.patch('/api/tasks/:id/panels/:instanceId', async (req, res) => {
    const parsed = updatePanelInputSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: describeZodError(parsed.error) })
      return
    }
    await applyChange(deps, req, res, {
      type: 'update',
      instanceId: String(req.params.instanceId),
      ...parsed.data
    })
  })

  app.delete('/api/tasks/:id/panels/:instanceId', async (req, res) => {
    await applyChange(deps, req, res, {
      type: 'close',
      instanceId: String(req.params.instanceId)
    })
  })
}
