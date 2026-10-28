import type { Express } from 'express'
import { startMainPty } from './_start-main'
import type { RestApiDeps } from '../types'
import { NOT_AVAILABLE_STANDALONE } from '../types'

export function registerPtyStartRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/pty/start', async (req, res) => {
    const pty = deps.pty
    if (!pty) {
      res.status(501).json({ error: NOT_AVAILABLE_STANDALONE })
      return
    }
    const body = req.body as { taskId?: unknown; timeoutMs?: unknown }
    const taskId = body?.taskId
    if (typeof taskId !== 'string' || !taskId) {
      res.status(400).json({ error: 'taskId required' })
      return
    }
    const timeoutMs = typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined

    const result = await startMainPty(deps, pty, taskId, { timeoutMs })

    if (result === 'already-alive') {
      res.json({ ok: true, alreadyAlive: true, sessionId: taskId })
      return
    }
    if (result === 'ok') {
      res.json({ ok: true, sessionId: taskId })
      return
    }
    if (result === 'no-task') {
      res.status(404).json({ error: `Task not found: ${taskId}` })
      return
    }
    if (result === 'no-window') {
      res.status(503).json({ error: 'No window available' })
      return
    }
    if (result === 'timeout') {
      res.status(504).json({ error: 'PTY start timed out' })
      return
    }
    res.status(500).json({ error: 'Renderer reported start failure' })
  })
}
