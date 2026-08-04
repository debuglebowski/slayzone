import type { Express, Response } from 'express'
import { CreateTaskInputSchema, type Task } from '@slayzone/task/shared'
import { createTaskOp, getTaskOp } from '@slayzone/task/server'
import { parseColumnsConfig, resolveStatusId } from '@slayzone/projects/shared'
import type { RestApiDeps } from '../types'
import { NOOP_TASK_BUS } from '../types'
import {
  isResolveFailure,
  resolveProjectRef,
  resolveTemplateRef,
  type ResolvedProject
} from '../resolve'

/**
 * POST /api/tasks — create a task (CLI `slay tasks create`).
 *
 * `slay tasks create` was the last command that could not work against a hub on
 * another machine: it opened the hub's SQLite file on its very first line, so a
 * remote hub died on `openDb()`'s "Database not found" `process.exit(1)` before a
 * flag was even considered. Everything it read that file for now happens here:
 *
 * - `project` is an id OR a case-insensitive name substring (shared
 *   `resolveProjectRef`, the CLI's `--project` semantics and messages). The
 *   stricter `projectId` stays for callers that already hold an id (renderer, MCP);
 *   supplying both is a 400 rather than a silent precedence rule.
 * - `status` accepts a column id, label, or slug and is resolved against the
 *   TARGET project's columns. Unresolvable is a 400 — `createTaskOp` would
 *   otherwise silently coerce an unknown status to the board's default, which is
 *   the same misplaced-logic bug `slay tasks done` had before slice 4.
 * - `template` is an id prefix (project-scoped) OR a template name, resolved to a
 *   concrete `templateId`.
 * - `externalId` / `externalProvider` are fields on the CREATE, so the hub writes
 *   them in the same transaction as the insert and emits ONE change. The CLI used
 *   to POST and then UPDATE the row directly behind the hub's back, so subscribed
 *   clients showed the task without its external identity until something else
 *   refreshed.
 *
 * The CLI-shaped fields are resolved to concrete ids BEFORE the domain schema
 * parses, so the strict `CreateTaskInputSchema` stays free of them (same shape as
 * the PATCH route's `appendDescription` handling).
 *
 * The response carries the resolved `project` alongside the task: the CLI prints
 * the project NAME in its `Created:` / `Exists:` line and must not read a database
 * to get it.
 */

/** CLI parity: priority must be an integer 1-5. Writes the 400 itself. */
function validPriority(value: unknown, res: Response): number | null | undefined {
  if (value === undefined || value === null) return undefined
  const p = typeof value === 'number' ? value : parseInt(String(value), 10)
  if (isNaN(p) || p < 1 || p > 5 || !Number.isInteger(p)) {
    res.status(400).json({ ok: false, error: 'Priority must be 1-5.' })
    return null
  }
  return p
}

export function registerCreateTaskRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/tasks', async (req, res) => {
    const body = { ...((req.body ?? {}) as Record<string, unknown>) }

    if (body.project !== undefined && body.projectId !== undefined) {
      res
        .status(400)
        .json({ ok: false, error: 'Provide either project or projectId, not both.' })
      return
    }
    const projectRef = body.project ?? body.projectId
    if (typeof projectRef !== 'string' || !projectRef) {
      res.status(400).json({ ok: false, error: 'project required' })
      return
    }
    delete body.project

    const priority = validPriority(body.priority, res)
    if (priority === null) return
    if (priority === undefined) delete body.priority
    else body.priority = priority

    const externalId = typeof body.externalId === 'string' ? body.externalId : undefined
    const externalProvider =
      typeof body.externalProvider === 'string' ? body.externalProvider : undefined

    try {
      const db = deps.db
      const resolvedProject = await resolveProjectRef(db, projectRef)
      if (isResolveFailure(resolvedProject)) {
        res.status(resolvedProject.status).json({ ok: false, error: resolvedProject.error })
        return
      }
      const project: ResolvedProject = resolvedProject.row
      body.projectId = project.id
      const projectSummary = { id: project.id, name: project.name }

      // Idempotent on the `idx_tasks_external_dedup` tuple: an import that runs
      // twice returns the task it already made instead of inserting a second one.
      //
      // `external_provider IS ?`, not `= ?`: a null provider never compares equal
      // in SQL, and SQLite treats NULLs as DISTINCT in a unique index — so the
      // CLI's `= :provider` dedupe silently created a duplicate on every re-run of
      // a provider-less `--external-id`. `IS` makes the tuple dedupe for real.
      const findExisting = async (): Promise<Task | null> => {
        const row = await db.get<{ id: string }>(
          `SELECT id FROM tasks
           WHERE project_id = ? AND external_provider IS ? AND external_id = ?
           LIMIT 1`,
          [project.id, externalProvider ?? null, externalId]
        )
        return row ? await getTaskOp(db, row.id) : null
      }

      if (externalId) {
        const existing = await findExisting()
        if (existing) {
          res.json({ ok: true, data: existing, existing: true, project: projectSummary })
          return
        }
      }

      if (typeof body.status === 'string') {
        const row = await db.get<{ columns_config: string | null }>(
          `SELECT columns_config FROM projects WHERE id = ? LIMIT 1`,
          [project.id]
        )
        const statusId = resolveStatusId(body.status, parseColumnsConfig(row?.columns_config))
        if (!statusId) {
          res.status(400).json({
            ok: false,
            error: `Unknown status "${body.status}" for project "${project.name}".`
          })
          return
        }
        body.status = statusId
      }

      if (typeof body.template === 'string') {
        const template = await resolveTemplateRef(db, project.id, body.template)
        if (isResolveFailure(template)) {
          res.status(template.status).json({ ok: false, error: template.error })
          return
        }
        body.templateId = template.row.id
      }
      delete body.template

      const parsed = CreateTaskInputSchema.safeParse(body)
      if (!parsed.success) {
        res.status(400).json({ ok: false, error: parsed.error.message })
        return
      }

      let task
      try {
        task = await createTaskOp(db, parsed.data, {
          ipcMain: deps.taskBus ?? NOOP_TASK_BUS,
          onMutation: deps.notifyRenderer
        })
      } catch (err) {
        // External-id UNIQUE race: another writer created the same task between
        // the lookup above and this insert — return theirs (same answer the
        // lookup would have given, one moment later).
        if (externalId && err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
          const existing = await findExisting()
          if (existing) {
            res.json({ ok: true, data: existing, existing: true, project: projectSummary })
            return
          }
        }
        throw err
      }

      if (!task) {
        res.status(404).json({ ok: false, error: 'Task not created' })
        return
      }
      res.json({ ok: true, data: task, project: projectSummary })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
