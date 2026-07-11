import { randomUUID } from 'node:crypto'
import type { Express } from 'express'
import type { RestApiDeps } from '../types'
import { isResolveFailure, resolveByIdPrefix } from '../resolve'

/**
 * POST /api/tasks/:id/reset-conversation — append `manual-reset` sentinel rows.
 * Mirrors `slay tasks reset-conversation` (cli/src/commands/tasks/
 * reset-conversation.ts): body `{ mode?: string }`; without a mode, every mode
 * that has a `task_conversations` row for the task is reset. Append-only —
 * a sentinel row (NULL conversation_id, origin 'manual-reset') plus the
 * mirrored `session_resets` timeline event (migration v147 triple-write).
 * Responds with the list of reset modes (empty when nothing to reset).
 */
export function registerTaskResetConversationRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/tasks/:id/reset-conversation', async (req, res) => {
    const body = (req.body ?? {}) as { mode?: unknown }
    if (body.mode !== undefined && typeof body.mode !== 'string') {
      res.status(400).json({ ok: false, error: 'mode must be a string' })
      return
    }
    try {
      const db = deps.db
      const task = await resolveByIdPrefix<{ id: string }>(db, 'tasks', req.params.id, 'Task', 'id')
      if (isResolveFailure(task)) {
        res.status(task.status).json({ ok: false, error: task.error })
        return
      }

      const modes = body.mode
        ? [body.mode]
        : (
            await db.all<{ mode: string }>(
              `SELECT DISTINCT mode FROM task_conversations WHERE task_id = ?`,
              [task.row.id]
            )
          ).map((r) => r.mode)

      if (modes.length === 0) {
        res.json({ ok: true, data: { reset: [] } })
        return
      }

      const createdAt = Date.now()
      const ops = modes.flatMap((mode) => {
        const resetId = randomUUID()
        return [
          {
            type: 'run' as const,
            sql: `INSERT INTO task_conversations (id, task_id, mode, conversation_id, origin, pending_meta, created_at)
                  VALUES (?, ?, ?, NULL, 'manual-reset', NULL, ?)`,
            params: [resetId, task.row.id, mode, createdAt]
          },
          {
            type: 'run' as const,
            sql: `INSERT INTO session_resets (id, task_id, mode, created_at)
                  VALUES (?, ?, ?, ?)`,
            params: [resetId, task.row.id, mode, createdAt]
          }
        ]
      })
      await db.batchTxn(ops)

      res.json({ ok: true, data: { reset: modes } })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
