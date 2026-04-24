import type { Express } from 'express'
import { writePty } from '@slayzone/terminal/main'
import type { RestApiDeps } from '../types'

export function registerPtyWriteRoute(app: Express, _deps: RestApiDeps): void {
  app.post('/api/pty/:id/write', (req, res) => {
    const ok = writePty(req.params.id, req.body.data)
    if (!ok) { res.status(404).json({ error: 'PTY session not found' }); return }
    res.json({ ok: true })
  })
}
