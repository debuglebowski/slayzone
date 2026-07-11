import type { Express, Response } from 'express'
import type { SlayzoneDb } from '@slayzone/platform'
import type { RestApiDeps } from '../types'
import { isResolveFailure, resolveByIdPrefix } from '../resolve'

/**
 * Dependency blockers for a task ("which tasks block :id").
 * Mirrors `slay tasks blockers` (cli/src/commands/tasks/blockers.ts):
 *
 * - GET    /api/tasks/:id/blockers            → current blockers
 * - POST   /api/tasks/:id/blockers  { add: string[] } | { set: string[] }
 * - DELETE /api/tasks/:id/blockers  { remove: string[] } | { clear: true }
 *
 * Blocker refs are id prefixes; self-blocking is rejected. Writes respond with
 * the resulting blocker list (CLI parity) and ping the renderer.
 */

const BLOCKERS_SQL = `SELECT t.id, t.project_id, t.title, t.status, t.priority, p.name AS project_name, t.created_at
   FROM tasks t JOIN task_dependencies td ON t.id = td.task_id
   JOIN projects p ON t.project_id = p.id
   WHERE td.blocks_task_id = ?`

type BlockerRefsResult = { ids: string[] } | { handled: true }

/** Resolve blocker id prefixes; writes the error response itself on failure. */
async function resolveBlockerRefs(
  db: SlayzoneDb,
  taskId: string,
  refs: unknown,
  res: Response
): Promise<BlockerRefsResult> {
  if (!Array.isArray(refs) || refs.length === 0 || refs.some((r) => typeof r !== 'string')) {
    res.status(400).json({ ok: false, error: 'Expected a non-empty array of task id prefixes' })
    return { handled: true }
  }
  const ids: string[] = []
  for (const ref of refs as string[]) {
    const resolved = await resolveByIdPrefix<{ id: string }>(db, 'tasks', ref, 'Task', 'id')
    if (isResolveFailure(resolved)) {
      res.status(resolved.status).json({ ok: false, error: resolved.error })
      return { handled: true }
    }
    if (resolved.row.id === taskId) {
      res.status(400).json({ ok: false, error: 'A task cannot block itself.' })
      return { handled: true }
    }
    ids.push(resolved.row.id)
  }
  return { ids }
}

export function registerTaskBlockersRoutes(app: Express, deps: RestApiDeps): void {
  app.get('/api/tasks/:id/blockers', async (req, res) => {
    try {
      const db = deps.db
      const task = await resolveByIdPrefix<{ id: string }>(db, 'tasks', req.params.id, 'Task', 'id')
      if (isResolveFailure(task)) {
        res.status(task.status).json({ ok: false, error: task.error })
        return
      }
      const blockers = await db.all(BLOCKERS_SQL, [task.row.id])
      res.json({ ok: true, data: blockers })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/tasks/:id/blockers', async (req, res) => {
    const body = (req.body ?? {}) as { add?: unknown; set?: unknown }
    if ((body.add === undefined) === (body.set === undefined)) {
      res.status(400).json({ ok: false, error: 'Provide exactly one of add, set' })
      return
    }
    try {
      const db = deps.db
      const task = await resolveByIdPrefix<{ id: string }>(db, 'tasks', req.params.id, 'Task', 'id')
      if (isResolveFailure(task)) {
        res.status(task.status).json({ ok: false, error: task.error })
        return
      }
      const taskId = task.row.id

      const resolved = await resolveBlockerRefs(db, taskId, body.set ?? body.add, res)
      if ('handled' in resolved) return

      const inserts = resolved.ids.map((bid) => ({
        type: 'run' as const,
        sql: `INSERT OR IGNORE INTO task_dependencies (task_id, blocks_task_id) VALUES (?, ?)`,
        params: [bid, taskId]
      }))
      await db.batchTxn(
        body.set !== undefined
          ? [
              {
                type: 'run' as const,
                sql: `DELETE FROM task_dependencies WHERE blocks_task_id = ?`,
                params: [taskId]
              },
              ...inserts
            ]
          : inserts
      )

      deps.notifyRenderer()
      const blockers = await db.all(BLOCKERS_SQL, [taskId])
      res.json({ ok: true, data: blockers })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete('/api/tasks/:id/blockers', async (req, res) => {
    const body = (req.body ?? {}) as { remove?: unknown; clear?: unknown }
    const clear = body.clear === true
    if ((body.remove === undefined) === !clear) {
      res.status(400).json({ ok: false, error: 'Provide exactly one of remove, clear' })
      return
    }
    try {
      const db = deps.db
      const task = await resolveByIdPrefix<{ id: string }>(db, 'tasks', req.params.id, 'Task', 'id')
      if (isResolveFailure(task)) {
        res.status(task.status).json({ ok: false, error: task.error })
        return
      }
      const taskId = task.row.id

      if (clear) {
        await db.run(`DELETE FROM task_dependencies WHERE blocks_task_id = ?`, [taskId])
      } else {
        const resolved = await resolveBlockerRefs(db, taskId, body.remove, res)
        if ('handled' in resolved) return
        await db.batchTxn(
          resolved.ids.map((bid) => ({
            type: 'run' as const,
            sql: `DELETE FROM task_dependencies WHERE task_id = ? AND blocks_task_id = ?`,
            params: [bid, taskId]
          }))
        )
      }

      deps.notifyRenderer()
      const blockers = await db.all(BLOCKERS_SQL, [taskId])
      res.json({ ok: true, data: blockers })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
