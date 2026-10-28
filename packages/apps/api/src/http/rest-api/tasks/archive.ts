import type { Express } from 'express'
import { archiveTaskOp } from '@slayzone/task/server'
import type { RestApiDeps } from '../types'
import { NOOP_TASK_BUS } from '../types'
import { isResolveFailure, resolveByIdPrefix } from '../resolve'

/**
 * POST /api/tasks/:id/archive — archive a task (CLI `slay tasks archive`).
 *
 * `:id` is a full id OR a unique id prefix, resolved by the shared
 * `resolveByIdPrefix` so the CLI never needs to open the hub's SQLite file to
 * translate a prefix (which made it unusable against a hub on another machine).
 * The `archived_at IS NULL` scope is the CLI's: an already-archived task is not
 * addressable, so re-archiving reads as "not found" rather than silently
 * re-stamping `archived_at`.
 *
 * The prefix match replaces the previous Zod `uuid()` guard — a non-uuid `:id`
 * is simply a prefix that matches nothing (404), which is what the CLI reported.
 */
export function registerArchiveTaskRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/tasks/:id/archive', async (req, res) => {
    try {
      const resolved = await resolveByIdPrefix<{ id: string; title: string }>(
        deps.db,
        'tasks',
        req.params.id,
        'Task',
        'id, title',
        { where: 'archived_at IS NULL' }
      )
      if (isResolveFailure(resolved)) {
        res.status(resolved.status).json({ ok: false, error: resolved.error })
        return
      }
      const task = await archiveTaskOp(deps.db, resolved.row.id, {
        ipcMain: deps.taskBus ?? NOOP_TASK_BUS,
        onMutation: deps.notifyRenderer
      })
      if (!task) {
        res.status(404).json({ ok: false, error: `Task not found: ${req.params.id}` })
        return
      }
      res.json({ ok: true, data: task })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
