import type { Express } from 'express'
import type { RestApiDeps } from '../types'
import { isResolveFailure, resolveByIdPrefix } from '../resolve'

/**
 * POST /api/open-task/:id — open a task in the app (CLI `slay tasks open`).
 *
 * `:id` is a full id OR a unique id prefix, resolved by the shared
 * `resolveByIdPrefix` so the CLI never needs to open the hub's SQLite file to
 * translate a prefix (which made it unusable against a hub on another machine).
 * The broadcast carries the FULL resolved id — the renderer looks the task up by
 * exact id, so a prefix must never reach it.
 *
 * Responds with the resolved `{ id, title }` because the CLI echoes both, and it
 * has no other way to learn them once it stops reading the DB itself.
 */
export function registerOpenTaskRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/open-task/:id', async (req, res) => {
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
      const { id: taskId, title } = resolved.row
      const background = req.query.background === '1' || req.query.background === 'true'
      deps.menu?.emit('open-task', { taskId, background })
      deps.legacyBroadcast?.('app:open-task', taskId, background) // slice 5: drop legacy send
      if (!background) {
        deps.windowActions?.raiseMainWindow()
      }
      res.json({ ok: true, data: { id: taskId, title } })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
