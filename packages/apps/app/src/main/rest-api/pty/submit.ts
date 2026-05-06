import type { Express } from 'express'
import { submitPty } from '@slayzone/terminal/electron'
import type { RestApiDeps } from '../types'

export function registerPtySubmitRoute(app: Express, _deps: RestApiDeps): void {
  app.post('/api/pty/:id/submit', (req, res) => {
    const text = req.body?.text
    if (typeof text !== 'string') {
      res.status(400).json({ error: 'Body must include "text" string' })
      return
    }
    const ok = submitPty(req.params.id, text)
    if (!ok) { res.status(404).json({ error: 'PTY session not found' }); return }
    res.json({ ok: true })
  })
}
