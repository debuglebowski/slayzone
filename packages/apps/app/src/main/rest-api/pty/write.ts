import type { Express } from 'express'
import { writePty, hasPty } from '@slayzone/terminal/main'
import { startMainPty, extractMainTaskId } from './_start-main'
import type { RestApiDeps } from '../types'

const AUTO_START_TIMEOUT_MS = 5_000

export function registerPtyWriteRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/pty/:id/write', async (req, res) => {
    const id = req.params.id
    if (!hasPty(id)) {
      const taskId = extractMainTaskId(id)
      if (taskId) {
        const r = await startMainPty(deps, taskId, { timeoutMs: AUTO_START_TIMEOUT_MS })
        if (r === 'no-window') { res.status(503).json({ error: 'No window available' }); return }
        if (r === 'timeout')   { res.status(504).json({ error: 'PTY start timed out' }); return }
        if (r === 'error')     { res.status(500).json({ error: 'Renderer reported start failure' }); return }
        // 'ok' | 'already-alive' | 'no-task' → fall through. 'no-task' (typo'd
        // id) lands at the writePty 404 below, preserving existing semantics.
      }
    }
    const ok = writePty(id, req.body.data)
    if (!ok) { res.status(404).json({ error: 'PTY session not found' }); return }
    res.json({ ok: true })
  })
}
