import type { Express } from 'express'
import type { RestApiDeps } from '../types'
import { NOT_AVAILABLE_STANDALONE } from '../types'

export function registerPtyKillRoute(app: Express, deps: RestApiDeps): void {
  app.delete('/api/pty/:id', (req, res) => {
    if (!deps.pty) {
      res.status(501).json({ error: NOT_AVAILABLE_STANDALONE })
      return
    }
    const ok = deps.pty.killPty(req.params.id)
    if (!ok) {
      res.status(404).json({ error: 'PTY session not found' })
      return
    }
    res.json({ ok: true })
  })
}
