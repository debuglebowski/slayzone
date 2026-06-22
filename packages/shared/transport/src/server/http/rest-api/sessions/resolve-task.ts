import type { Express } from 'express'
import type { RestApiDeps } from '../types'

/**
 * Resolve the task currently bound to an agent session (plans/agent-sessions.md
 * slice 4 / path B). A pre-warmed pooled agent launches WITHOUT
 * `SLAYZONE_TASK_ID` (it has no task yet) but with an immutable
 * `SLAYZONE_SESSION_ID`. The `slay` CLI calls this to learn its task live —
 * source of truth is `agent_sessions.task_id`, set at pool-adoption
 * (`bindSessionToTask`). Returns `{ taskId: null }` for an unbound/unknown
 * session (CLI then errors as "no task").
 */
export function registerResolveSessionTaskRoute(app: Express, deps: RestApiDeps): void {
  app.get('/api/session/:sessionId/task', async (req, res) => {
    try {
      const row = await deps.db.get<{ task_id: string | null }>(
        `SELECT task_id FROM agent_sessions WHERE id = ?`,
        [req.params.sessionId]
      )
      res.json({ taskId: row?.task_id ?? null })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })
}
