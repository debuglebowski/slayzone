import type { Express } from 'express'
import { deleteTaskOp } from '@slayzone/task/server'
import type { RestApiDeps } from '../types'
import { NOOP_TASK_BUS } from '../types'
import { isResolveFailure, resolveByIdPrefix } from '../resolve'

/**
 * DELETE /api/tasks/:id — soft-delete a task (CLI `slay tasks delete`).
 *
 * `:id` is a full id OR a unique id prefix, resolved by the shared
 * `resolveByIdPrefix` so the CLI never needs to open the hub's SQLite file to
 * translate a prefix (which made it unusable against a hub on another machine).
 * Unlike archive there is no scope predicate — the CLI matched the whole table
 * here, so an archived task stays deletable.
 *
 * The prefix match replaces the previous Zod `uuid()` guard — a non-uuid `:id`
 * is simply a prefix that matches nothing (404), which is what the CLI reported.
 */
export function registerDeleteTaskRoute(app: Express, deps: RestApiDeps): void {
  app.delete('/api/tasks/:id', async (req, res) => {
    try {
      const resolved = await resolveByIdPrefix<{ id: string; title: string }>(
        deps.db,
        'tasks',
        req.params.id,
        'Task',
        'id, title'
      )
      if (isResolveFailure(resolved)) {
        res.status(resolved.status).json({ ok: false, error: resolved.error })
        return
      }
      const task = resolved.row
      const result = await deleteTaskOp(deps.db, task.id, {
        ipcMain: deps.taskBus ?? NOOP_TASK_BUS,
        onMutation: deps.notifyRenderer
      })
      if (result === false) {
        res.status(404).json({ ok: false, error: `Task not found: ${req.params.id}` })
        return
      }
      // `data` keeps its established boolean | { blocked } contract; the resolved
      // task rides ALONGSIDE it so the CLI can echo `id  title` without a DB read.
      res.json({ ok: true, data: result, task: { id: task.id, title: task.title } })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
