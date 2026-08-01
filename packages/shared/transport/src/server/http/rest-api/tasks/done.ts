import type { Express } from 'express'
import { updateTaskOp } from '@slayzone/task/server'
import { getDoneStatus, parseColumnsConfig } from '@slayzone/projects/shared'
import type { RestApiDeps } from '../types'
import { NOOP_TASK_BUS } from '../types'
import { isResolveFailure, resolveByIdPrefix } from '../resolve'

/**
 * POST /api/tasks/:id/done — mark a task done (CLI `slay tasks done [--close]`).
 *
 * WHY THIS IS A SEPARATE ROUTE FROM `PATCH /api/tasks/:id { status }`
 *
 * They express different things. PATCH's `status` is a NAME the caller chose,
 * resolved as an alias against the project's columns (`resolveStatusId`: id →
 * label → slug). Done is an INTENT with no name: "whichever column this project
 * treats as completed". The hub answers it with `getDoneStatus`, which reads the
 * column CATEGORY (`completed`) rather than matching text.
 *
 * The two are not interchangeable. A project whose completed column is `closed`
 * has no column named/labelled/slugged "done", so `resolveStatusId('done', …)`
 * returns null and PATCH would 400 — while the done intent still has an
 * unambiguous answer (`closed`). Having the CLI send a concrete status would put
 * the category lookup back in the CLI, which is precisely the misplaced logic
 * this route removes: it used to `openDb()` the hub's SQLite file to read
 * `projects.columns_config`, so `slay tasks done` could not work against a hub on
 * another machine.
 *
 * `:id` is a full id OR a unique id prefix (shared `resolveByIdPrefix`, same
 * 404/400 messages as the CLI reported).
 *
 * `{ close: true }` folds in the CLI's `--close`: it closes the task's UI tab via
 * the injected menu bus — the same channel `POST /api/close-task/:id` and the MCP
 * `update_task` tool use. Folded in rather than left as a second CLI call because
 * only the resolved FULL id can close the right tab, and the CLI's own way of
 * learning it was the DB read this route replaces. The response reports whether a
 * close was actually dispatched (`closed`), so a host with no UI to close (the
 * standalone hub: no `menu`, no `legacyBroadcast`) is reported honestly instead of
 * silently claiming success.
 */
export function registerDoneTaskRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/tasks/:id/done', async (req, res) => {
    const body = (req.body ?? {}) as { close?: unknown }
    try {
      const resolved = await resolveByIdPrefix<{ id: string; title: string; project_id: string }>(
        deps.db,
        'tasks',
        req.params.id,
        'Task',
        'id, title, project_id'
      )
      if (isResolveFailure(resolved)) {
        res.status(resolved.status).json({ ok: false, error: resolved.error })
        return
      }
      const task = resolved.row

      const projectRow = await deps.db.get<{ columns_config: string | null }>(
        `SELECT columns_config FROM projects WHERE id = ? LIMIT 1`,
        [task.project_id]
      )
      // Never null: getDoneStatus falls back to the DEFAULT_COLUMNS completed
      // column, and ultimately to 'done' — the same total function the app's own
      // done buttons use, so CLI and UI can't disagree on what done means.
      const doneStatus = getDoneStatus(parseColumnsConfig(projectRow?.columns_config))

      const updated = await updateTaskOp(
        deps.db,
        { id: task.id, status: doneStatus },
        {
          ipcMain: deps.taskBus ?? NOOP_TASK_BUS,
          onMutation: deps.notifyRenderer
        }
      )
      if (!updated) {
        res.status(404).json({ ok: false, error: `Task not found: ${req.params.id}` })
        return
      }

      // Dual-dispatch, mirroring close.ts: the menu bus is the live channel, the
      // legacy broadcast is the pre-slice-5 renderer path.
      //
      // `closed` reports the HOST's CAPABILITY (is a close channel wired at all),
      // deliberately NOT `emit()`'s return value. `emit` is false whenever no
      // listener is attached *at that instant*, and the renderer attaches by tRPC
      // subscription — so keying off it would warn spuriously mid-reconnect while
      // the tab does get closed. Capability is stable, and it is the only thing
      // that actually distinguishes "no UI exists here" (standalone hub → the CLI
      // should say so) from "dispatched". Same posture as `POST /api/close-task/:id`,
      // which answers `{ok:true}` for a dispatch it cannot confirm either.
      const closeChannels = (deps.menu ? 1 : 0) + (deps.legacyBroadcast ? 1 : 0)
      let closed = false
      if (body.close === true) {
        deps.menu?.emit('close-task', task.id)
        deps.legacyBroadcast?.('app:close-task', task.id)
        closed = closeChannels > 0
      }

      res.json({
        ok: true,
        data: { id: task.id, title: updated.title, status: doneStatus, closed }
      })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
