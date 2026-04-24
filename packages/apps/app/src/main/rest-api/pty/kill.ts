import type { Express } from 'express'
import { killPty } from '@slayzone/terminal/main'
import type { RestApiDeps } from '../types'

export function registerPtyKillRoute(app: Express, _deps: RestApiDeps): void {
  app.delete('/api/pty/:id', (req, res) => {
    const ok = killPty(req.params.id)
    if (!ok) { res.status(404).json({ error: 'PTY session not found' }); return }
    res.json({ ok: true })
  })
}
