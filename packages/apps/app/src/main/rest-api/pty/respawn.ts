import type { Express } from 'express'
import { requestEnsureAlive } from '@slayzone/terminal/electron'
import { broadcastToWindows } from '../../broadcast-to-windows'
import { menuEvents } from '../../menu-events'
import type { RestApiDeps } from '../types'

const FORCE_RESPAWN_TIMEOUT_MS = 3_000

export function registerPtyRespawnRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/pty/respawn', async (req, res) => {
    const taskId = (req.body as { taskId?: unknown })?.taskId
    if (typeof taskId !== 'string' || !taskId) {
      res.status(400).json({ error: 'taskId required' })
      return
    }
    const row = await deps.db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId)
    if (!row) {
      res.status(404).json({ error: `Task not found: ${taskId}` })
      return
    }
    // Open the task tab so its TaskDetailPage mounts and attaches the
    // onEnsureAlive listener. requestEnsureAlive retries until acked or
    // times out, so race with mount is handled.
    menuEvents.emit('open-task', { taskId })
    broadcastToWindows('app:open-task', taskId) // slice 5: drop legacy send
    const result = await requestEnsureAlive(taskId, {
      force: true,
      timeoutMs: FORCE_RESPAWN_TIMEOUT_MS
    })
    if (result === 'ok' || result === 'already-alive') {
      res.json({ ok: true })
      return
    }
    if (result === 'no-window') {
      res.status(503).json({ error: 'No window available' })
      return
    }
    if (result === 'error') {
      res.status(500).json({ error: 'Renderer reported respawn failure' })
      return
    }
    res.status(408).json({
      error:
        'Renderer did not acknowledge respawn within timeout — task tab may be closed or app unresponsive'
    })
  })
}
