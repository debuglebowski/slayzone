import type { Express } from 'express'
import type { RestApiDeps } from '../types'
import { isResolveFailure, resolveByIdPrefix } from '../resolve'

/**
 * Manual "blocked waiting" flag on a task (the `is_blocked` / `blocked_comment`
 * columns — distinct from dependency blockers). Mirrors `slay tasks blocked`
 * (cli/src/commands/tasks/blocked.ts):
 *
 * - GET  /api/tasks/:id/blocked                      → current state + dep blockers
 * - POST /api/tasks/:id/blocked  { on: true }        → set blocked
 *                                { off: true }       → clear blocked + comment
 *                                { toggle: true }    → flip
 *                                { comment: string } → set blocked + comment
 *                                { comment: null }   → clear comment only
 *
 * Both respond with `{ is_blocked, blocked_comment, blockers }` (CLI parity),
 * where `blockers` is the dependency-based blocker list shown for context.
 */

interface BlockedRow {
  id: string
  is_blocked: number
  blocked_comment: string | null
}

async function readState(
  db: RestApiDeps['db'],
  taskId: string
): Promise<{ is_blocked: boolean; blocked_comment: string | null; blockers: unknown[] }> {
  const updated = await db.get<{ is_blocked: number; blocked_comment: string | null }>(
    `SELECT is_blocked, blocked_comment FROM tasks WHERE id = ?`,
    [taskId]
  )
  const blockers = await db.all(
    `SELECT t.id, t.title FROM tasks t JOIN task_dependencies td ON t.id = td.task_id
     WHERE td.blocks_task_id = ?`,
    [taskId]
  )
  return {
    is_blocked: Boolean(updated?.is_blocked),
    blocked_comment: updated?.blocked_comment ?? null,
    blockers
  }
}

export function registerTaskBlockedRoutes(app: Express, deps: RestApiDeps): void {
  app.get('/api/tasks/:id/blocked', async (req, res) => {
    try {
      const task = await resolveByIdPrefix<{ id: string }>(
        deps.db,
        'tasks',
        req.params.id,
        'Task',
        'id'
      )
      if (isResolveFailure(task)) {
        res.status(task.status).json({ ok: false, error: task.error })
        return
      }
      res.json({ ok: true, data: await readState(deps.db, task.row.id) })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/tasks/:id/blocked', async (req, res) => {
    const body = (req.body ?? {}) as {
      on?: unknown
      off?: unknown
      toggle?: unknown
      comment?: unknown
    }
    const hasComment = 'comment' in body
    if (
      body.comment !== undefined &&
      body.comment !== null &&
      typeof body.comment !== 'string'
    ) {
      res.status(400).json({ ok: false, error: 'comment must be a string or null' })
      return
    }
    try {
      const db = deps.db
      const resolved = await resolveByIdPrefix<BlockedRow>(
        db,
        'tasks',
        req.params.id,
        'Task',
        'id, is_blocked, blocked_comment'
      )
      if (isResolveFailure(resolved)) {
        res.status(resolved.status).json({ ok: false, error: resolved.error })
        return
      }
      const task = resolved.row
      const now = new Date().toISOString()

      if (body.on === true) {
        await db.run(`UPDATE tasks SET is_blocked = 1, updated_at = ? WHERE id = ?`, [now, task.id])
      } else if (body.off === true) {
        await db.run(
          `UPDATE tasks SET is_blocked = 0, blocked_comment = NULL, updated_at = ? WHERE id = ?`,
          [now, task.id]
        )
      } else if (body.toggle === true) {
        if (task.is_blocked) {
          await db.run(
            `UPDATE tasks SET is_blocked = 0, blocked_comment = NULL, updated_at = ? WHERE id = ?`,
            [now, task.id]
          )
        } else {
          await db.run(`UPDATE tasks SET is_blocked = 1, updated_at = ? WHERE id = ?`, [
            now,
            task.id
          ])
        }
      } else if (typeof body.comment === 'string') {
        await db.run(
          `UPDATE tasks SET is_blocked = 1, blocked_comment = ?, updated_at = ? WHERE id = ?`,
          [body.comment, now, task.id]
        )
      } else if (hasComment && body.comment === null) {
        // --no-comment: clear the comment only, leaving is_blocked as-is.
        await db.run(`UPDATE tasks SET blocked_comment = NULL, updated_at = ? WHERE id = ?`, [
          now,
          task.id
        ])
      }

      const isWrite =
        body.on === true ||
        body.off === true ||
        body.toggle === true ||
        typeof body.comment === 'string' ||
        (hasComment && body.comment === null)
      if (isWrite) deps.notifyRenderer()

      res.json({ ok: true, data: await readState(db, task.id) })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
