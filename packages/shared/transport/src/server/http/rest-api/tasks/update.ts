import type { Express } from 'express'
import { updateTaskInputSchema, type UpdateTaskInput } from '@slayzone/task/shared'
import { updateTaskOp } from '@slayzone/task/server'
import { parseColumnsConfig, resolveStatusId } from '@slayzone/projects/shared'
import type { RestApiDeps } from '../types'
import { NOOP_TASK_BUS } from '../types'
import { isResolveFailure, resolveByIdPrefix } from '../resolve'

/**
 * PATCH /api/tasks/:id — update a task (CLI `slay tasks update`, plus the
 * narrower `slay tasks done` / `slay tasks progress` writers).
 *
 * Everything the CLI used to read the hub's SQLite file for now happens here, so
 * the CLI works against a hub on another machine:
 *
 * - `:id` is a full id OR a unique id prefix (shared `resolveByIdPrefix`). This
 *   replaces the old Zod `uuid()` guard on the raw param — a non-uuid `:id` is
 *   just a prefix that matches nothing (404), which is what the CLI reported.
 * - `status` accepts a column id, label, or slug and is resolved against THIS
 *   task's project columns; an unresolvable one is a 400 rather than the silent
 *   coercion-to-default `updateTask` would otherwise apply.
 * - `parentId` accepts an id prefix too, and reports failures as `Parent task
 *   not found` / `Ambiguous parent id prefix` so the operator can tell which
 *   argument was at fault. `null` still detaches (never read as a prefix).
 * - `appendDescription` appends to the STORED description (read here, inside the
 *   request, instead of the CLI pre-reading it) — the CLI's
 *   `--append-description`. Mutually exclusive with `description`.
 *
 * `appendDescription` is resolved to a concrete `description` before the domain
 * schema parses, so the strict `updateTaskInputSchema` stays free of
 * CLI-shaped fields.
 */
export function registerUpdateTaskRoute(app: Express, deps: RestApiDeps): void {
  app.patch('/api/tasks/:id', async (req, res) => {
    const body = { ...((req.body ?? {}) as Record<string, unknown>) }

    // CLI parity: the two description writers contradict each other.
    if (body.description !== undefined && body.appendDescription !== undefined) {
      res
        .status(400)
        .json({ ok: false, error: 'Cannot use both --description and --append-description.' })
      return
    }

    try {
      const resolved = await resolveByIdPrefix<{
        id: string
        project_id: string
        description: string | null
      }>(deps.db, 'tasks', req.params.id, 'Task', 'id, project_id, description')
      if (isResolveFailure(resolved)) {
        res.status(resolved.status).json({ ok: false, error: resolved.error })
        return
      }
      const task = resolved.row
      body.id = task.id

      if (typeof body.status === 'string') {
        const row = await deps.db.get<{ columns_config: string | null }>(
          `SELECT columns_config FROM projects WHERE id = ? LIMIT 1`,
          [task.project_id]
        )
        const statusId = resolveStatusId(body.status, parseColumnsConfig(row?.columns_config))
        if (!statusId) {
          res.status(400).json({
            ok: false,
            error: `Unknown status "${body.status}" for this task's project.`
          })
          return
        }
        body.status = statusId
      }

      // A string parent is an id prefix; null detaches and must pass through.
      if (typeof body.parentId === 'string') {
        const parent = await resolveByIdPrefix<{ id: string }>(
          deps.db,
          'tasks',
          body.parentId,
          'Parent task',
          'id',
          { ambiguousLabel: 'parent id prefix' }
        )
        if (isResolveFailure(parent)) {
          res.status(parent.status).json({ ok: false, error: parent.error })
          return
        }
        body.parentId = parent.row.id
      }

      if (typeof body.appendDescription === 'string') {
        body.description = (task.description ?? '') + '\n' + body.appendDescription
        delete body.appendDescription
      }

      const parsed = updateTaskInputSchema.safeParse(body)
      if (!parsed.success) {
        res.status(400).json({ ok: false, error: parsed.error.message })
        return
      }

      const updated = await updateTaskOp(deps.db, parsed.data as UpdateTaskInput, {
        ipcMain: deps.taskBus ?? NOOP_TASK_BUS,
        onMutation: deps.notifyRenderer
      })
      if (!updated) {
        res.status(404).json({ ok: false, error: `Task not found: ${req.params.id}` })
        return
      }
      res.json({ ok: true, data: updated })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
